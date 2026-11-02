// Server + workbench tests against the mock service. Run: node http-tests.mjs
import http from "node:http";
import net from "node:net";
import { createWorkbench } from "../../canvas/instance.mjs";
import { GitLabError } from "../../canvas/gitlab.mjs";
import { startServer } from "../../canvas/server.mjs";
import { fileURLToPath } from "node:url";
import { getStore, makeMockService, mockDetect, resetStores } from "./mock-service.mjs";
import fs from "node:fs";

const PUBLIC_DIR = fileURLToPath(new URL("../../canvas/public/", import.meta.url));
let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) pass++;
    else {
        fail++;
        console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`);
    }
};
const section = (name) => console.log(`# ${name}`);

const logs = [];
async function boot({ cwd = "/tmp/work", input = {}, id = "t", launchSession } = {}) {
    const workbench = createWorkbench({ instanceId: id, cwd, input, detect: mockDetect, makeService: makeMockService, launchSession });
    const server = await startServer({ publicDir: PUBLIC_DIR, workbench, log: (l, m) => logs.push(`${l}: ${m}`) });
    return { workbench, server, port: server.port, token: server.token };
}

function raw({ port, method = "GET", path = "/", headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...headers } }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {}
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

const api = (s) => async (method, path, payload, extra = {}) =>
    raw({ port: s.port, method, path, headers: { "x-canvas-token": s.token, ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...extra }, body: payload !== undefined ? JSON.stringify(payload) : undefined });

function sse(s, { query = `?k=${s.token}`, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const events = [];
        let buf = "";
        const req = http.request({ host: "127.0.0.1", port: s.port, path: `/events${query}`, headers }, (res) => {
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf("\n\n")) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const type = /^event: (.*)$/m.exec(block)?.[1];
                    const data = /^data: (.*)$/m.exec(block)?.[1];
                    if (type) events.push({ type, data: data ? JSON.parse(data) : null });
                }
            });
            resolve({ res, events, close: () => req.destroy(), waitFor: (type, ms = 2000) => waitUntil(() => events.find((e) => e.type === type), ms) });
        });
        req.on("error", reject);
        req.end();
    });
}

async function waitUntil(fn, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 15));
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
section("static files, headers, path handling");
{
    resetStores();
    const s = await boot();
    const r = await raw({ port: s.port, path: "/" });
    check("GET / 200", r.status === 200, r.status);
    check("html content-type", /^text\/html/.test(r.headers["content-type"]), r.headers["content-type"]);
    const csp = r.headers["content-security-policy"] ?? "";
    for (const d of ["script-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) check(`CSP has ${d}`, csp.includes(d), csp);
    check("CSP has no unsafe-inline/eval for scripts", !/script-src[^;]*unsafe/.test(csp));
    check("nosniff", r.headers["x-content-type-options"] === "nosniff");
    check("no-store", /no-store/.test(r.headers["cache-control"] ?? ""));
    check("no-referrer", r.headers["referrer-policy"] === "no-referrer");
    check("index has #app", r.text.includes('id="app"'));
    check("index has no inline script", !/<script(?![^>]*\bsrc=)[^>]*>/i.test(r.text));
    check("index has no inline event handlers", !/\son\w+\s*=/i.test(r.text));

    const css = await raw({ port: s.port, path: "/app.css" });
    check("css 200 + mime", css.status === 200 && /^text\/css/.test(css.headers["content-type"]));
    check("static assets allow cross-origin module loads", css.headers["access-control-allow-origin"] === "*");

    for (const file of fs.readdirSync(`${PUBLIC_DIR}/js`)) {
        const js = await raw({ port: s.port, path: `/js/${file}` });
        check(`/js/${file} 200 + js mime`, js.status === 200 && /^text\/javascript/.test(js.headers["content-type"]), `${js.status} ${js.headers["content-type"]}`);
    }

    for (const p of ["/js/../server.mjs", "/js/..%2fserver.mjs", "/js/%2e%2e/server.mjs", "/js/%2e%2e%2fserver.mjs", "/js/..%5cserver.mjs", "/server.mjs", "/gitlab.mjs", "/extension.mjs", "/js/", "/js/nope.js", "/js/%", "/%", "/js/%E0%A4%A", "/app.css/", "/index.html/extra", "//etc/passwd", "/js/app.js%00.png", "/.env"]) {
        const x = await raw({ port: s.port, path: p });
        check(`404 for ${p}`, x.status === 404 || x.status === 400, `${x.status} ${x.text.slice(0, 60)}`);
        check(`no source leaked for ${p}`, !/createServer|export async function startServer/.test(x.text));
    }
    const after = await raw({ port: s.port, path: "/" });
    check("server still alive after hostile paths", after.status === 200);

    const post = await raw({ port: s.port, method: "POST", path: "/" });
    check("POST / is 405", post.status === 405, post.status);
    await s.server.close();
}

// ---------------------------------------------------------------------------------------------
section("token, Host, Origin, content-type");
{
    resetStores();
    const s = await boot();
    const call = api(s);
    let r = await raw({ port: s.port, path: "/api/state" });
    check("no token -> 403 bad_token", r.status === 403 && r.json?.error?.code === "bad_token", `${r.status} ${r.text}`);
    r = await raw({ port: s.port, path: "/api/state", headers: { "x-canvas-token": "x".repeat(32) } });
    check("wrong token -> 403", r.status === 403);
    r = await raw({ port: s.port, path: "/api/state", headers: { "x-canvas-token": "" } });
    check("empty token -> 403", r.status === 403);
    r = await raw({ port: s.port, path: `/api/state?k=${s.token}` });
    check("?k= is NOT accepted for the JSON API", r.status === 403, r.status);
    r = await call("GET", "/api/state");
    check("valid token -> 200 + ok envelope", r.status === 200 && r.json?.ok === true && r.json.data.configured === true, r.text.slice(0, 120));
    check("state exposes project", r.json.data.project?.path === "acme/flask-demo");

    for (const host of ["evil.com", "127.0.0.1.evil.com", "evil.com:80", "localhost.evil.com", "0.0.0.0", "[::2]"]) {
        const x = await raw({ port: s.port, path: "/api/state", headers: { "x-canvas-token": s.token, host } });
        check(`Host "${host}" rejected`, x.status === 403, x.status);
        const y = await raw({ port: s.port, path: "/", headers: { host } });
        check(`Host "${host}" rejected for static too`, y.status === 403, y.status);
    }
    const noHost = await new Promise((resolve) => {
        const sock = net.connect(s.port, "127.0.0.1", () => sock.write("GET /api/state HTTP/1.0\r\nx-canvas-token: " + s.token + "\r\n\r\n"));
        let out = "";
        sock.on("data", (c) => (out += c));
        sock.on("close", () => resolve(out));
    });
    check("missing Host header rejected", /^HTTP\/1\.1 403/.test(noHost), noHost.slice(0, 40));
    for (const host of ["localhost:4000", "127.0.0.1", "[::1]:9", "LOCALHOST"]) {
        const x = await raw({ port: s.port, path: "/api/state", headers: { "x-canvas-token": s.token, host } });
        check(`Host "${host}" accepted`, x.status === 200, x.status);
    }
    for (const origin of ["http://evil.com", "https://127.0.0.1", "http://127.0.0.1.evil.com", "file://", "http://localhost.evil.com", "chrome-extension://abc", "not a url"]) {
        const x = await raw({ port: s.port, path: "/api/state", headers: { "x-canvas-token": s.token, origin } });
        check(`Origin "${origin}" rejected`, x.status === 403 && x.json?.error?.code === "bad_origin", `${x.status} ${x.text.slice(0, 80)}`);
        check(`no ACAO for rejected Origin "${origin}"`, !x.headers["access-control-allow-origin"]);
    }
    for (const origin of ["null", "http://localhost:5555", "http://127.0.0.1:1", "http://[::1]:5"]) {
        const x = await raw({ port: s.port, path: "/api/state", headers: { "x-canvas-token": s.token, origin } });
        check(`Origin "${origin}" accepted`, x.status === 200, x.status);
        check(`ACAO echoes "${origin}"`, x.headers["access-control-allow-origin"] === origin, x.headers["access-control-allow-origin"]);
    }
    let pre = await raw({ port: s.port, method: "OPTIONS", path: "/api/items", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
    check("preflight 204 for loopback origin", pre.status === 204 && /POST/.test(pre.headers["access-control-allow-methods"] ?? ""), pre.status);
    check("preflight allows custom token header", /x-canvas-token/i.test(pre.headers["access-control-allow-headers"] ?? ""));
    pre = await raw({ port: s.port, method: "OPTIONS", path: "/api/items", headers: { origin: "http://evil.com" } });
    check("preflight rejected for foreign origin", pre.status === 403, pre.status);

    r = await raw({ port: s.port, method: "POST", path: "/api/items", headers: { "x-canvas-token": s.token }, body: JSON.stringify({ title: "x" }) });
    check("POST without content-type -> 415", r.status === 415, r.status);
    r = await raw({ port: s.port, method: "POST", path: "/api/items", headers: { "x-canvas-token": s.token, "content-type": "text/plain" }, body: JSON.stringify({ title: "x" }) });
    check("POST text/plain -> 415 (blocks no-cors form posts)", r.status === 415, r.status);
    r = await raw({ port: s.port, method: "POST", path: "/api/items", headers: { "x-canvas-token": s.token, "content-type": "application/x-www-form-urlencoded" }, body: "title=x" });
    check("POST form-encoded -> 415", r.status === 415);
    r = await call("POST", "/api/items", undefined, { "content-type": "application/json" });
    check("POST empty body -> title required (400)", r.status === 400 && r.json.error.code === "invalid", `${r.status} ${r.text}`);
    r = await raw({ port: s.port, method: "POST", path: "/api/items", headers: { "x-canvas-token": s.token, "content-type": "application/json" }, body: "{nope" });
    check("invalid JSON -> 400 invalid_json", r.status === 400 && r.json.error.code === "invalid_json", `${r.status} ${r.text}`);
    r = await raw({ port: s.port, method: "POST", path: "/api/items", headers: { "x-canvas-token": s.token, "content-type": "application/json" }, body: "[1,2]" });
    check("array body -> 400", r.status === 400);
    r = await raw({ port: s.port, method: "POST", path: "/api/items", headers: { "x-canvas-token": s.token, "content-type": "application/json" }, body: "null" });
    check("null body -> 400", r.status === 400);
    r = await raw({ port: s.port, method: "POST", path: "/api/items", headers: { "x-canvas-token": s.token, "content-type": "application/json" }, body: JSON.stringify({ title: "x", description: "a".repeat(1024 * 1024 + 10) }) });
    check("body > 1 MB -> 413", r.status === 413 && r.json?.error?.code === "too_large", `${r.status} ${r.text.slice(0, 80)}`);
    r = await call("GET", "/api/state");
    check("server alive after oversize body", r.status === 200);
    r = await call("GET", "/api/nope");
    check("unknown endpoint -> 404 JSON", r.status === 404 && r.json.error.code === "not_found");
    r = await call("DELETE", "/api/state");
    check("wrong method -> 405", r.status === 405 && r.json.error.code === "method_not_allowed");
    r = await call("GET", "/api/items/abc");
    check("non-numeric iid -> 404", r.status === 404);
    r = await call("GET", "/api/items/1%00");
    check("odd iid -> 404 not a crash", r.status === 404, r.status);
    await s.server.close();
}

// ---------------------------------------------------------------------------------------------
section("items API: list, get, create, update, comment, link");
{
    resetStores();
    const s = await boot();
    const call = api(s);
    const store = getStore("acme/flask-demo");
    store.latency = 0;

    let r = await call("GET", "/api/meta");
    check("meta 200", r.status === 200 && r.json.data.types.length === 4 && r.json.data.labels.length > 5, r.text.slice(0, 80));
    check("meta has scopes", JSON.stringify(r.json.data.scopes) === '["priority","workflow"]', JSON.stringify(r.json.data.scopes));
    check("meta has the signed-in user", r.json.data.user?.username === "feured");

    r = await call("GET", "/api/items");
    check("list 200", r.status === 200 && r.json.data.items.length === 10 && r.json.data.total === 10, `${r.status} total=${r.json?.data?.total}`);
    check("list default is open only", r.json.data.items.every((i) => i.state === "open"));
    check("list sorted by updated desc", r.json.data.items.map((i) => i.updatedAt).every((t, i, a) => i === 0 || a[i - 1] >= t));

    store.calls.length = 0;
    r = await call("GET", "/api/items?state=all&label=bug&label=frontend&assignee=none&milestone=none&search=%23123&sort=title_asc&type=Task&first=7&after=3");
    const seen = store.calls.find((c) => c.method === "list");
    check("query string -> filter object", JSON.stringify(seen?.args.filter) === JSON.stringify({ state: "all", type: "Task", label: ["bug", "frontend"], assignee: "none", milestone: "none", search: "#123", sort: "title_asc" }), JSON.stringify(seen?.args));
    check("paging args forwarded", seen?.args.first === 7 && seen?.args.after === "3", JSON.stringify(seen?.args));

    const meta0 = (await call("GET", "/api/meta")).json.data;
    const taskRule = meta0.types.find((t) => t.name === "Task");
    const issueRule = meta0.types.find((t) => t.name === "Issue");
    check("meta carries the hierarchy rules", [...taskRule.parentTypes].sort().join() === "Incident,Issue,Ticket" && taskRule.childTypes.length === 0 && issueRule.childTypes.join() === "Task" && issueRule.parentTypes.length === 0, JSON.stringify([taskRule, issueRule]));
    check("meta says scoped labels exclude each other", meta0.scopedLabels === true, String(meta0.scopedLabels));

    store.calls.length = 0;
    r = await call("GET", "/api/items?state=all&type=Task&type=Ticket");
    const multi = store.calls.find((c) => c.method === "list");
    check("repeated type -> array filter", JSON.stringify(multi?.args.filter.type) === '["Task","Ticket"]', JSON.stringify(multi?.args.filter));
    check("multi-type list only has those types", r.json.data.items.length >= 3 && r.json.data.items.every((i) => ["Task", "Ticket"].includes(i.type.name)) && new Set(r.json.data.items.map((i) => i.type.name)).size === 2, JSON.stringify(r.json.data.items.map((i) => [i.iid, i.type.name])));
    store.calls.length = 0;
    await call("GET", "/api/items?type=Issue");
    check("a single type stays a string", store.calls.find((c) => c.method === "list")?.args.filter.type === "Issue");

    r = await call("GET", "/api/items?state=all&first=5");
    check("paging: first page has next", r.json.data.items.length === 5 && r.json.data.hasNextPage === true && r.json.data.endCursor === "5");
    r = await call("GET", "/api/items?state=all&first=5&after=10");
    check("paging: last page", r.json.data.items.length === 3 && r.json.data.hasNextPage === false);
    r = await call("GET", "/api/items?sort=bogus");
    check("bad sort -> 400", r.status === 400, r.status);
    r = await call("GET", "/api/items?assignee=me");
    check("assignee=me", r.json.data.items.every((i) => i.assignees.some((u) => u.username === "feured")) && r.json.data.items.length >= 2);

    r = await call("GET", "/api/items/1");
    const d = r.json.data;
    check("detail 200", r.status === 200 && d.iid === 1 && d.description.includes("Acceptance criteria"));
    check("detail has discussions/children/linked/tasks", d.discussions.length === 3 && d.children.length === 2 && d.linked.length === 1 && d.tasks.total === 4 && d.tasks.done === 1, JSON.stringify({ disc: d.discussions.length, ch: d.children.length, l: d.linked.length, t: d.tasks }));
    r = await call("GET", "/api/items/99999");
    check("missing item -> 404 not_found", r.status === 404 && r.json.error.code === "not_found" && /99999/.test(r.json.error.message));

    r = await call("PATCH", "/api/items/12", { title: "Renamed by test", addLabels: ["bug", "workflow::review"], assignees: ["alice"], milestone: "v1.1", dueDate: "2031-02-03" });
    check("update 200", r.status === 200 && r.json.data.title === "Renamed by test" && r.json.data.labels.length === 2 && r.json.data.assignees[0].username === "alice" && r.json.data.milestone.title === "v1.1" && r.json.data.dueDate === "2031-02-03", r.text.slice(0, 120));
    r = await call("PATCH", "/api/items/12", { removeLabels: ["bug"], milestone: "", dueDate: "", assignees: [] });
    check("update clears fields", r.json.data.labels.length === 1 && r.json.data.milestone === null && r.json.data.dueDate === null && r.json.data.assignees.length === 0, r.text.slice(0, 160));
    r = await call("PATCH", "/api/items/12", { title: "" });
    check("empty title -> 400 invalid", r.status === 400 && r.json.error.code === "invalid");
    r = await call("PATCH", "/api/items/12", { addLabels: ["does-not-exist"] });
    check("unknown label -> 400", r.status === 400 && /Unknown label/.test(r.json.error.message), r.text);
    r = await call("PATCH", "/api/items/12", { dueDate: "tomorrow" });
    check("bad date -> 400", r.status === 400);
    r = await call("PATCH", "/api/items/12", { state: "closed" });
    check("close item", r.json.data.state === "closed" && r.json.data.closedAt);
    r = await call("PATCH", "/api/items/12", { state: "open" });
    check("reopen item", r.json.data.state === "open" && r.json.data.closedAt === null);

    r = await call("POST", "/api/items", { title: "Created by test", type: "Task", parent: 1, labels: ["docs"], assignees: ["bob"], milestone: "v1.0", confidential: true, description: "- [ ] one\n- [x] two" });
    const created = r.json?.data;
    check("create 200 with detail", r.status === 200 && created?.iid === 14 && created.type.name === "Task" && created.parent?.iid === 1 && created.confidential === true && created.tasks?.total === 2, r.text.slice(0, 160));
    r = await call("GET", "/api/items/1");
    check("parent lists the new child", r.json.data.children.some((c) => c.iid === 14));
    r = await call("POST", "/api/items", { title: "x", type: "Epic" });
    check("unknown type -> 400", r.status === 400 && /Unknown work item type/.test(r.json.error.message));
    r = await call("POST", "/api/items", { title: "FAIL ME please" });
    check("mutation_failed -> 502", r.status === 502 && r.json.error.code === "mutation_failed", `${r.status} ${r.text}`);
    r = await call("POST", "/api/items", { title: "child of a task", type: "Task", parent: 7 });
    check("hierarchy rule error surfaces", r.status === 502 && /cannot have child/i.test(r.json.error.message), r.text);

    r = await call("POST", "/api/items/3/comments", { body: "Hello **world**" });
    check("comment 200", r.status === 200 && r.json.data.body === "Hello **world**" && r.json.data.author.username === "feured", r.text.slice(0, 100));
    r = await call("POST", "/api/items/3/comments", { body: "   " });
    check("empty comment -> 400", r.status === 400);
    r = await call("POST", "/api/items/3/comments", {});
    check("missing comment body -> 400", r.status === 400);

    r = await call("POST", "/api/items/12/links", { target: 4, type: "blocks" });
    check("link blocks", r.status === 200 && r.json.data.linked.some((l) => l.type === "blocks" && l.item.iid === 4), r.text.slice(0, 160));
    r = await call("GET", "/api/items/4");
    check("reverse side sees blocked_by", r.json.data.linked.some((l) => l.type === "blocked_by" && l.item.iid === 12));
    r = await call("POST", "/api/items/12/links", { target: 4, type: "related" });
    check("duplicate link -> 502 mutation_failed", r.status === 502, `${r.status} ${r.text}`);
    r = await call("POST", "/api/items/12/links", { target: 12 });
    check("self link -> 400", r.status === 400);
    r = await call("POST", "/api/items/12/links", { target: 555 });
    check("link to missing -> 404", r.status === 404);
    r = await call("DELETE", "/api/items/12/links/4");
    check("unlink", r.status === 200 && r.json.data.linked.length === 0);
    r = await call("DELETE", "/api/items/12/links/4");
    check("unlink twice -> 404", r.status === 404);

    r = await call("GET", "/api/merge-requests");
    check("merge request list defaults to opened", r.status === 200 && r.json.data.items.length === 1 && r.json.data.items[0].iid === 1, r.text.slice(0, 100));
    r = await call("GET", "/api/merge-requests?state=all&search=milestone");
    check("merge request list filters by state and search", r.status === 200 && r.json.data.total === 1 && r.json.data.items[0].title.includes("milestone"), r.text.slice(0, 120));
    r = await call("GET", "/api/merge-requests?state=all&first=1&page=2");
    const mrPageCall = store.calls.findLast((c) => c.method === "listMergeRequests");
    check("merge request list forwards paging", r.status === 200 && mrPageCall?.args.first === 1 && mrPageCall.args.page === 2, JSON.stringify(mrPageCall));
    r = await call("GET", "/api/merge-requests/1");
    check("merge request detail includes discussion and branches", r.status === 200 && r.json.data.sourceBranch === "feature/achievement-milestones" && Array.isArray(r.json.data.discussions), r.text.slice(0, 120));
    r = await call("GET", "/api/merge-requests/999");
    check("missing merge request -> 404", r.status === 404 && r.json.error.code === "not_found");
    r = await call("POST", "/api/merge-requests", { title: "Test new merge request", sourceBranch: "feature/test", targetBranch: "main", description: "Ready for review", labels: ["frontend"], draft: true });
    const newMr = r.json?.data;
    check("create merge request", r.status === 200 && newMr.iid === 2 && newMr.draft && newMr.sourceBranch === "feature/test", r.text.slice(0, 160));
    r = await call("POST", "/api/merge-requests", { title: "", sourceBranch: "feature/test", targetBranch: "main" });
    check("invalid merge request create -> 400", r.status === 400);
    r = await call("PUT", "/api/merge-requests/2", { title: "Edited test MR", targetBranch: "stable", labels: ["bug"], draft: false });
    check("update merge request fields", r.status === 200 && r.json.data.title === "Edited test MR" && r.json.data.targetBranch === "stable" && !r.json.data.draft, r.text.slice(0, 140));
    r = await call("POST", "/api/merge-requests/2/comments", { body: "Looks good to me." });
    check("comment on merge request", r.status === 200 && r.json.data.body === "Looks good to me." && r.json.data.author.username === "feured", r.text.slice(0, 120));
    r = await call("POST", "/api/merge-requests/2/approve", {});
    check("approve merge request", r.status === 200 && r.json.data.iid === 2);
    r = await call("PUT", "/api/merge-requests/2", { state: "closed" });
    check("close merge request", r.status === 200 && r.json.data.state === "closed");
    r = await call("PUT", "/api/merge-requests/2", { state: "opened" });
    check("reopen merge request", r.status === 200 && r.json.data.state === "opened");
    r = await call("POST", "/api/merge-requests/2/merge", {});
    check("merge merge request", r.status === 200 && r.json.data.state === "merged" && r.json.data.mergedAt);
    r = await call("GET", "/api/merge-requests?state=merged");
    check("merged state filter", r.status === 200 && r.json.data.items.some((mr) => mr.iid === 2));

    store.failNext = { code: "network", message: "Could not reach gitlab.com" };
    r = await call("PATCH", "/api/items/12", { title: "will fail" });
    check("GitLabError(network) -> 502 + code + message", r.status === 502 && r.json.error.code === "network" && /gitlab\.com/.test(r.json.error.message), r.text);
    store.failNext = { code: "forbidden", message: "No access" };
    r = await call("PATCH", "/api/items/12", { title: "will fail" });
    check("forbidden -> 403", r.status === 403);
    store.failNext = { code: "auth", message: "Not logged in" };
    r = await call("PATCH", "/api/items/12", { title: "will fail" });
    check("auth -> 502 with code", r.status === 502 && r.json.error.code === "auth");

    r = await call("PUT", "/api/view", { mode: "board", groupBy: "scope:workflow", filters: { state: "all", label: ["bug"], sort: "title_asc" }, selected: 3 });
    check("view update", r.status === 200 && r.json.data.mode === "board" && r.json.data.groupBy === "scope:workflow" && r.json.data.filters.state === "all" && r.json.data.selected === 3, r.text);
    r = await call("GET", "/api/state");
    check("state reflects view", r.json.data.view.mode === "board" && r.json.data.view.filters.label[0] === "bug");
    for (const bad of [{ mode: "kanban" }, { groupBy: "nope" }, { groupBy: "scope:" }, { filters: { state: "weird" } }, { filters: { sort: "bogus" } }, { selected: -4 }, { selected: "abc" }, { filters: { label: Array.from({ length: 21 }, (_, i) => `l${i}`) } }, { filters: { search: "x".repeat(300) } }]) {
        const x = await call("PUT", "/api/view", bad);
        check(`bad view ${JSON.stringify(bad).slice(0, 50)} -> 400`, x.status === 400, `${x.status} ${x.text.slice(0, 80)}`);
    }
    r = await call("PUT", "/api/view", { selected: null });
    check("selected: null clears", r.json.data.selected === null);
    await s.server.close();
}

// ---------------------------------------------------------------------------------------------
section("live events (SSE)");
{
    resetStores();
    const a = await boot({ id: "A" });
    const b = await boot({ id: "B" });
    await a.workbench.init();
    await b.workbench.init();
    for (const s of [a, b]) getStore("acme/flask-demo").latency = 0;
    let r = await raw({ port: a.port, path: "/events" });
    check("/events without token -> 403", r.status === 403);
    r = await raw({ port: a.port, path: "/events?k=wrong" });
    check("/events wrong token -> 403", r.status === 403);
    r = await raw({ port: a.port, path: `/events?k=${a.token}`, headers: { origin: "http://evil.com" } });
    check("/events foreign origin -> 403", r.status === 403);
    r = await raw({ port: a.port, method: "POST", path: `/events?k=${a.token}`, headers: { "x-canvas-token": a.token } });
    check("/events POST -> 405", r.status === 405);

    const ea = await sse(a);
    const eb = await sse(b, { query: "", headers: { "x-canvas-token": b.token } });
    check("SSE content type", /text\/event-stream/.test(ea.res.headers["content-type"]));
    check("SSE headers: no-transform", /no-transform/.test(ea.res.headers["cache-control"]));
    const hello = await ea.waitFor("hello");
    check("hello event carries instanceId", hello?.data?.instanceId === "A", JSON.stringify(hello));
    check("token via header also works for /events", !!(await eb.waitFor("hello")));

    await api(a)("PATCH", "/api/items/12", { title: "SSE test" });
    const changedB = await eb.waitFor("changed");
    const changedA = await ea.waitFor("changed");
    check("mutation via A announces `changed` to B (same project)", changedB?.data?.by === "ui" && changedB.data.source === "A", JSON.stringify(changedB));
    check("A also hears its own change (so it can refresh)", !!changedA);

    a.workbench.setView({ mode: "board" }, { broadcast: true });
    const viewA = await ea.waitFor("view");
    check("agent view change is pushed as `view`", viewA?.data?.view?.mode === "board", JSON.stringify(viewA));
    check("view broadcast stays inside its own instance", !eb.events.some((e) => e.type === "view"));
    await api(a)("PUT", "/api/view", { mode: "list" });
    await new Promise((r) => setTimeout(r, 60));
    check("UI-initiated PUT /api/view does not echo a `view` event", ea.events.filter((e) => e.type === "view").length === 1);

    const before = eb.events.length;
    await b.workbench.update(12, { title: "agent edit" }, "agent");
    const agentChange = await waitUntil(() => eb.events.slice(before).find((e) => e.type === "changed" && e.data.by === "agent"));
    check("agent change tagged by:agent", !!agentChange);

    const clients = [];
    for (let i = 0; i < 10; i++) clients.push(await sse(a));
    await new Promise((r) => setTimeout(r, 80));
    const stillAlive = await api(a)("GET", "/api/state");
    check("more than 8 SSE clients: server evicts the oldest, stays healthy", stillAlive.status === 200);
    clients.forEach((c) => c.close());
    ea.close();
    eb.close();

    await a.server.close();
    check("close() ends open streams without hanging", true);
    const gone = await raw({ port: a.port, path: "/" }).then(() => false, () => true);
    check("closed server refuses connections", gone);
    await b.server.close();
}

// ---------------------------------------------------------------------------------------------
section("no project / switching project");
{
    resetStores();
    const s = await boot({ cwd: "/tmp/no-remote" });
    const call = api(s);
    let r = await call("GET", "/api/state");
    check("unconfigured state", r.json.data.configured === false && r.json.data.project === null && /No GitLab remote/.test(r.json.data.problem), r.text);
    r = await call("GET", "/api/items");
    check("items without project -> 409 no_project", r.status === 409 && r.json.error.code === "no_project", `${r.status} ${r.text}`);
    r = await call("GET", "/api/meta");
    check("meta without project -> 409", r.status === 409);
    r = await call("POST", "/api/items", { title: "x" });
    check("create without project -> 409", r.status === 409);
    r = await call("POST", "/api/project", { project: "not a project !!" });
    check("garbage project -> 400", r.status === 400, `${r.status} ${r.text}`);
    r = await call("POST", "/api/project", { project: "nope/missing" });
    check("unknown project -> 404 and stays unconfigured", r.status === 404, `${r.status} ${r.text}`);
    r = await call("GET", "/api/state");
    check("still unconfigured after failed switch", r.json.data.configured === false);
    r = await call("POST", "/api/project", { project: "https://gitlab.com/acme/other/-/issues" });
    check("URL accepted -> configured", r.status === 200 && r.json.data.project.path === "acme/other" && r.json.data.configured, r.text.slice(0, 120));
    r = await call("GET", "/api/items");
    check("items of the new project", r.json.data.total === 1 && r.json.data.items[0].title === "Only item in the other project");
    await call("PUT", "/api/view", { mode: "board", filters: { state: "all" }, selected: 1 });
    r = await call("POST", "/api/project", { project: "acme/empty" });
    check("switching resets filters/selection but keeps the mode", r.json.data.view.filters.state === "open" && r.json.data.view.selected === null && r.json.data.view.mode === "board", JSON.stringify(r.json.data.view));
    r = await call("GET", "/api/items");
    check("empty project lists nothing", r.json.data.total === 0 && r.json.data.items.length === 0);
    await s.server.close();

    const t = await boot({ cwd: "/tmp/work", input: { project: "not-valid" } });
    const st = await api(t)("GET", "/api/state");
    check("invalid open input -> problem message", st.json.data.configured === false && /not a GitLab project/.test(st.json.data.problem), st.text);
    await t.server.close();
    const u = await boot({ cwd: "/tmp/work", input: { project: "acme/other" } });
    const su = await api(u)("GET", "/api/state");
    check("open input overrides detection", su.json.data.project.path === "acme/other");
    const mu = (await api(u)("GET", "/api/meta")).json.data;
    check("rules unavailable -> null (unrestricted), not an empty list", mu.scopedLabels === null && mu.types.every((t) => t.childTypes === null && t.parentTypes === null), JSON.stringify(mu.types[0]));
    await u.server.close();
}

// ---------------------------------------------------------------------------------------------
section("open a Copilot session from a work item");
{
    resetStores();
    const requests = [];
    const launched = { sessionId: "6b1e0f2c-3d4a-4b5c-8d6e-7f8091a2b3c4", navigated: true };
    const s = await boot({ id: "session", launchSession: async (request) => (requests.push(request), launched) });
    const call = api(s);
    let r = await call("GET", "/api/state");
    check("state tells the panel that this host can open sessions", r.json.data.capabilities?.openSession === true, r.text.slice(0, 200));
    r = await call("POST", "/api/items/1/session", {});
    check("POST /api/items/1/session -> 200 with the new session", r.status === 200 && r.json.data.sessionId === launched.sessionId && r.json.data.navigated === true, `${r.status} ${r.text}`);
    const [request] = requests;
    check("the launcher runs once with a short name", requests.length === 1 && request.name.startsWith("Issue #1: Add clicker") && request.name.length <= 40, JSON.stringify(request)?.slice(0, 200));
    check("its first message names the project and carries the item", /work item #1 in acme\/flask-demo/.test(request.prompt) && request.prompt.includes("Add clicker achievements and milestones") && request.prompt.includes("Added the schema in `achievements.py`."), request.prompt?.slice(0, 300));

    r = await call("POST", "/api/items/9999/session", {});
    check("an unknown item -> 404 and nothing is launched", r.status === 404 && r.json.error.code === "not_found" && requests.length === 1, `${r.status} ${r.text}`);
    r = await call("POST", "/api/items/1/session");
    check("a POST without a JSON content type -> 415 and nothing is launched", r.status === 415 && requests.length === 1, `${r.status} ${r.text}`);
    r = await raw({ port: s.port, method: "POST", path: "/api/items/1/session", headers: { "content-type": "application/json" }, body: "{}" });
    check("a POST without the token -> 403 and nothing is launched", r.status === 403 && requests.length === 1, `${r.status} ${r.text}`);
    r = await call("POST", "/api/items/1/session", {}, { origin: "https://evil.example" });
    check("a POST from a foreign origin -> 403 and nothing is launched", r.status === 403 && requests.length === 1, `${r.status} ${r.text}`);
    r = await call("GET", "/api/items/1/session");
    check("GET is not allowed on the route -> 405", r.status === 405, `${r.status} ${r.text}`);
    r = await call("POST", "/api/items/one/session", {});
    check("a non-numeric item number is an unknown endpoint -> 404", r.status === 404 && requests.length === 1, `${r.status} ${r.text}`);
    await s.server.close();

    const failing = await boot({ id: "session-failing", launchSession: async () => { throw new GitLabError("session_failed", "Could not open a Copilot session: denied"); } });
    r = await api(failing)("POST", "/api/items/1/session", {});
    check("a launcher failure -> 502 session_failed with its message", r.status === 502 && r.json.error.code === "session_failed" && /denied/.test(r.json.error.message), `${r.status} ${r.text}`);
    await failing.server.close();

    const bare = await boot({ id: "session-bare" });
    r = await api(bare)("GET", "/api/state");
    check("without a launcher the state says sessions cannot be opened", r.json.data.capabilities?.openSession === false, r.text.slice(0, 200));
    r = await api(bare)("POST", "/api/items/1/session", {});
    check("without a launcher -> 501 unsupported", r.status === 501 && r.json.error.code === "unsupported" && /GitHub Copilot app/.test(r.json.error.message), `${r.status} ${r.text}`);
    await bare.server.close();

    const none = await boot({ id: "session-none", cwd: "/tmp/no-remote", launchSession: async () => { throw new Error("must not run"); } });
    r = await api(none)("POST", "/api/items/1/session", {});
    check("without a project -> 409 no_project and nothing is launched", r.status === 409 && r.json.error.code === "no_project", `${r.status} ${r.text}`);
    await none.server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (logs.length) console.log("server log:", logs.join(" | "));
process.exit(fail ? 1 : 0);

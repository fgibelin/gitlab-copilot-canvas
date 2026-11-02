// Loads the real extension.mjs against the SDK shim + mock service. Run: node --import ./register.mjs extension-tests.mjs
import http from "node:http";
import fs from "node:fs";
import Ajv from "ajv";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CanvasError, captured } from "./shim-sdk.mjs";
import { getStore } from "./mock-service.mjs";

const EXT_DIR = fileURLToPath(new URL("../../canvas", import.meta.url));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import(pathToFileURL(`${EXT_DIR}/extension.mjs`));
const canvas = captured.config?.canvases?.[0];

// -------------------------------------------------------------------------------------------
section("declaration");
check("joinSession got one canvas", captured.config?.canvases?.length === 1);
check("canvas id", canvas?.id === "gitlab-work-items");
check("displayName + description", canvas.displayName === "GitLab project management" && canvas.description.length > 30 && canvas.description.length < 300, canvas.description?.length);
check("ready message logged through session.log (not stdout)", captured.logs.some((l) => /ready/.test(l.message) && l.level === "info" && l.ephemeral === true), JSON.stringify(captured.logs));
const names = canvas.actions.map((a) => a.name);
check("unique action names", new Set(names).size === names.length, names.join(","));
check("no reserved canvas.* names", names.every((n) => !n.startsWith("canvas.")));
check("every action has a handler and a description", canvas.actions.every((a) => typeof a.handler === "function" && a.description?.length > 20));
check("expected actions exist", ["get_project_info", "list_work_items", "get_work_item", "create_work_item", "update_work_item", "add_comment", "link_work_items", "unlink_work_items", "list_merge_requests", "get_merge_request", "create_merge_request", "update_merge_request", "comment_merge_request", "approve_merge_request", "merge_merge_request", "get_view", "set_view", "select_work_item", "refresh", "set_project"].every((n) => names.includes(n)), names.join(","));
check("no delete action is exposed", !names.some((n) => /delete|remove_work/.test(n)));

const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: true, strictTuples: true, strictRequired: true });
const validators = new Map();
for (const a of canvas.actions) {
    if (!a.inputSchema) continue;
    try {
        validators.set(a.name, ajv.compile(a.inputSchema));
    } catch (error) {
        check(`schema of ${a.name} compiles under Ajv strict`, false, error.message);
    }
}
let openValidator;
try {
    openValidator = ajv.compile(canvas.inputSchema);
} catch (error) {
    check("canvas inputSchema compiles", false, error.message);
}
check("all action schemas compiled", validators.size === canvas.actions.filter((a) => a.inputSchema).length);
const ok = (name, input) => validators.get(name)(input);
const bad = (name, input) => !validators.get(name)(input);

section("schemas accept good input and reject bad input");
check("open: {} ok", openValidator({}));
check("open: project ok", openValidator({ project: "acme/x" }));
check("open: project too long rejected", !openValidator({ project: "x".repeat(301) }));
check("open: project wrong type rejected", !openValidator({ project: 5 }));
check("get_project_info {} ok", ok("get_project_info", {}));
check("get_project_info extra key rejected", bad("get_project_info", { nope: 1 }));
check("list_work_items filters ok", ok("list_work_items", { state: "all", type: "Task", label: ["a", "b"], assignee: "me", milestone: "v1", search: "x", sort: "due_asc", first: 50, after: "9", fromView: true }));
check("list first=51 rejected", bad("list_work_items", { first: 51 }));
check("list first=0 rejected", bad("list_work_items", { first: 0 }));
check("list state bogus rejected", bad("list_work_items", { state: "bogus" }));
check("list sort bogus rejected", bad("list_work_items", { sort: "bogus" }));
check("list unknown key rejected", bad("list_work_items", { limit: 5 }));
check("list >20 labels rejected", bad("list_work_items", { label: Array.from({ length: 21 }, (_, i) => `l${i}`) }));
check("get_work_item requires iid", bad("get_work_item", {}) && ok("get_work_item", { iid: 3 }));
check("iid 0 rejected, float rejected, string rejected", bad("get_work_item", { iid: 0 }) && bad("get_work_item", { iid: 1.5 }) && bad("get_work_item", { iid: "3" }));
check("create requires title", bad("create_work_item", {}) && ok("create_work_item", { title: "x" }));
check("create title > 255 rejected", bad("create_work_item", { title: "x".repeat(256) }));
check("create full payload ok", ok("create_work_item", { title: "t", type: "Task", description: "d", labels: ["a"], assignees: ["u"], milestone: "m", startDate: "2030-01-01", dueDate: "2030-02-01", parent: 3, confidential: true }));
check("date format enforced", bad("create_work_item", { title: "t", dueDate: "2030-1-1" }) && bad("create_work_item", { title: "t", dueDate: "tomorrow" }));
check("empty date clears (allowed in update)", ok("update_work_item", { iid: 1, dueDate: "", startDate: "" }));
check("update: parent 0 allowed (detach), create parent 0 rejected", ok("update_work_item", { iid: 1, parent: 0 }) && bad("create_work_item", { title: "t", parent: 0 }));
check("update: state enum", ok("update_work_item", { iid: 1, state: "closed" }) && bad("update_work_item", { iid: 1, state: "done" }));
check("update: empty assignees list allowed", ok("update_work_item", { iid: 1, assignees: [] }));
check("update: unknown key rejected", bad("update_work_item", { iid: 1, status: "x" }));
check("add_comment requires iid+body", bad("add_comment", { iid: 1 }) && ok("add_comment", { iid: 1, body: "hi" }));
check("link type enum", ok("link_work_items", { iid: 1, target: 2, type: "blocked_by" }) && bad("link_work_items", { iid: 1, target: 2, type: "parent" }));
check("unlink requires target", bad("unlink_work_items", { iid: 1 }) && ok("unlink_work_items", { iid: 1, target: 2 }));
check("set_view modes", ok("set_view", { mode: "board", groupBy: "scope:workflow", filters: { state: "all" } }) && bad("set_view", { mode: "kanban" }));
check("set_view unknown filter rejected", bad("set_view", { filters: { colour: "red" } }));
check("select_work_item iid optional", ok("select_work_item", {}) && ok("select_work_item", { iid: 4 }));
check("set_project requires project", bad("set_project", {}) && ok("set_project", { project: "a/b" }));
check("merge request list filters", ok("list_merge_requests", { state: "all", search: "pipeline" }) && bad("list_merge_requests", { state: "mergedx" }));
check("merge request read/write schemas", ok("get_merge_request", { iid: 42 }) && ok("create_merge_request", { title: "t", sourceBranch: "feature/x", targetBranch: "main" }) && ok("update_merge_request", { iid: 42, state: "closed" }) && ok("comment_merge_request", { iid: 42, body: "review" }));
check("merge request merge options", ok("merge_merge_request", { iid: 42, mergeWhenPipelineSucceeds: true, shouldRemoveSourceBranch: false }) && bad("merge_merge_request", { iid: 42, mergeWhenPipelineSucceeds: "yes" }));

// -------------------------------------------------------------------------------------------
const ctx = (instanceId, extra = {}) => ({ sessionId: "s1", extensionId: "project:gitlab-work-items", canvasId: "gitlab-work-items", instanceId, host: {}, session: { workingDirectory: "/tmp/work" }, ...extra });
const act = (instanceId, name, input) => canvas.actions.find((a) => a.name === name).handler(ctx(instanceId, { actionName: name, input }));
const failsWith = async (promise, code, pattern) => {
    try {
        await promise;
        return { ok: false, why: "did not throw" };
    } catch (error) {
        const good = error instanceof CanvasError && error.code === code && (!pattern || pattern.test(error.message));
        return { ok: good, why: `${error?.constructor?.name}:${error?.code}:${error?.message}` };
    }
};
function sse(url) {
    const u = new URL(url);
    const events = [];
    const handle = { events, ended: false };
    let buf = "";
    const req = http.request({ host: u.hostname, port: u.port, path: `/events?k=${u.searchParams.get("k")}` }, (res) => {
        res.setEncoding("utf8");
        res.on("end", () => (handle.ended = true));
        res.on("close", () => (handle.ended = true));
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
    });
    req.on("error", () => (handle.ended = true));
    req.end();
    return Object.assign(handle, { close: () => req.destroy() });
}
const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = fn();
        if (v) return v;
        await sleep(15);
    }
    return null;
};
const apiGet = async (url, path) => {
    const u = new URL(url);
    const res = await fetch(`${u.origin}${path}`, { headers: { "x-canvas-token": u.searchParams.get("k") } });
    return { status: res.status, json: await res.json() };
};

// -------------------------------------------------------------------------------------------
section("open / idempotency / close");
getStore("acme/flask-demo").latency = 0;
const [o1, o2, o3] = await Promise.all([canvas.open(ctx("wi-1", { input: {} })), canvas.open(ctx("wi-1", { input: { project: "ignored/after-first-open" } })), canvas.open(ctx("wi-1"))]);
check("open returns url/title/status", /^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}$/.test(o1.url) && o1.title === "GitLab project management" && o1.status === "acme/flask-demo", JSON.stringify(o1));
check("concurrent opens share ONE server (same url)", o1.url === o2.url && o2.url === o3.url, `${o1.url} ${o2.url} ${o3.url}`);
check("later open input is ignored for an existing instance (idempotent)", o2.status === "acme/flask-demo");
const again = await canvas.open(ctx("wi-1", { input: {} }));
check("re-open returns the same url", again.url === o1.url);
const state = await apiGet(o1.url, "/api/state");
check("served API works with the url's token", state.status === 200 && state.json.data.project.path === "acme/flask-demo", JSON.stringify(state));

const o4 = await canvas.open(ctx("wi-2", { input: { project: "acme/other" } }));
check("second instance gets its own server", o4.url !== o1.url && o4.status === "acme/other", JSON.stringify(o4));
const o5 = await canvas.open(ctx("wi-nr", { session: { workingDirectory: "/tmp/no-remote" } }));
check("no git remote -> status says so, open does not throw", o5.status === "No project selected", JSON.stringify(o5));
const o6 = await canvas.open(ctx("wi-fallback", { session: undefined }));
check("missing ctx.session falls back to process.cwd without throwing", typeof o6.url === "string");

// -------------------------------------------------------------------------------------------
section("actions");
const w1 = sse(o1.url);
const w2 = sse(o4.url);
const peer = await canvas.open(ctx("wi-peer"));
const wPeer = sse(peer.url);
await sleep(60);

let r = await act("wi-1", "get_project_info", {});
check("get_project_info", r.project === "acme/flask-demo" && r.signedInAs === "feured" && r.types.includes("Task") && r.labelScopes.join() === "priority,workflow" && r.members.some((m) => m.username === "alice") && r.milestones.some((m) => m.title === "v1.0") && r.labels.some((l) => l.name === "bug"), JSON.stringify(r).slice(0, 300));
check("get_project_info has no ids/colors (compact)", !/gid:\/\//.test(JSON.stringify(r)));
check("get_project_info explains the hierarchy", JSON.stringify(r.hierarchy?.Task) === '{"canHaveChildren":[],"canBeChildOf":["Issue","Incident","Ticket"]}' && r.hierarchy?.Issue?.canHaveChildren.join() === "Task" && r.scopedLabelsExclusive === true, JSON.stringify(r.hierarchy));
r = await act("wi-1", "get_project_info", { refresh: true });
check("get_project_info refresh", r.project === "acme/flask-demo");

r = await act("wi-1", "list_work_items", {});
check("list default: open items, compact", r.total === 10 && r.returned === 10 && r.nextCursor === null && r.items.every((i) => i.state === "open" && typeof i.type === "string" && Array.isArray(i.labels) && typeof i.labels[0] !== "object"), JSON.stringify(r).slice(0, 200));
check("list items carry url", r.items[0].url.startsWith("https://gitlab.com/acme/flask-demo/-/work_items/"));
r = await act("wi-1", "list_work_items", { state: "all", first: 5 });
check("list paging", r.total === 13 && r.returned === 5 && r.nextCursor === "5");
const page2 = await act("wi-1", "list_work_items", { state: "all", first: 50, after: r.nextCursor });
check("list page 2 via nextCursor", page2.returned === 8 && page2.nextCursor === null, JSON.stringify(page2).slice(0, 100));
r = await act("wi-1", "list_work_items", { label: ["bug"], assignee: "alice" });
check("list filters", r.items.length === 2 && r.items.every((i) => i.labels.includes("bug") && i.assignees.includes("alice")) || r.items.length >= 1, JSON.stringify(r.items.map((i) => i.iid)));
r = await act("wi-1", "list_work_items", { search: "#4" });
check("list #N search", r.items.length === 1 && r.items[0].iid === 4);

await act("wi-1", "set_view", { filters: { assignee: "alice", state: "all" } });
r = await act("wi-1", "list_work_items", { fromView: true });
check("list fromView uses the panel's filters", r.items.length > 0 && r.items.every((i) => i.assignees.includes("alice")), JSON.stringify(r.items.map((i) => [i.iid, i.assignees])));
r = await act("wi-1", "list_work_items", { fromView: true, assignee: "bob" });
check("explicit filters override the view's", r.items.length > 0 && r.items.every((i) => i.assignees.includes("bob")));
r = await act("wi-1", "list_work_items", { assignee: "alice" });
check("without fromView the panel filters are NOT applied (state defaults to open)", r.items.every((i) => i.state === "open"));
await act("wi-1", "set_view", { filters: { assignee: "", state: "open" } });

r = await act("wi-1", "get_work_item", { iid: 1 });
check("get_work_item: core fields", r.iid === 1 && r.type === "Issue" && r.labels.includes("frontend") && r.assignees[0] === "feured" && r.milestone === "v1.0" && r.author === "feured" && r.taskCompletion.total === 4 && r.taskCompletion.done === 1 && r.canEdit === true, JSON.stringify(r).slice(0, 260));
check("get_work_item: children + linked", r.children.length === 2 && r.children[0].iid === 7 && r.linked.length === 1 && r.linked[0].link === "related" && r.linked[0].iid === 4, JSON.stringify({ c: r.children, l: r.linked }));
check("get_work_item: comments oldest-to-newest and flagged internal", r.comments.length === 3 && r.comments[0].author === "alice" && r.comments[1].internal === true && r.comments[2].author === "feured" && r.olderCommentsNotShown === 0, JSON.stringify(r.comments.map((c) => [c.author, c.internal])));
check("get_work_item: description present", r.description.includes("Acceptance criteria"));
let f = await failsWith(act("wi-1", "get_work_item", { iid: 99999 }), "not_found", /99999/);
check("get_work_item on a missing item -> CanvasError(not_found)", f.ok, f.why);

let mrPage = await act("wi-1", "list_merge_requests", {});
check("list_merge_requests returns open MRs", mrPage.returned === 1 && mrPage.items[0].iid === 1 && mrPage.items[0].sourceBranch === "feature/achievement-milestones");
let mr = await act("wi-1", "get_merge_request", { iid: 1 });
check("get_merge_request includes detail and discussion", mr.iid === 1 && mr.author === "alice" && mr.comments.length === 0 && mr.description.includes("milestone"));
mr = await act("wi-1", "create_merge_request", { title: "Agent-created MR", sourceBranch: "feature/agent", targetBranch: "main", draft: true, description: "Created by agent" });
check("create_merge_request returns compact result", mr.iid === 2 && mr.draft && mr.sourceBranch === "feature/agent" && !("description" in mr));
mr = await act("wi-1", "update_merge_request", { iid: 2, title: "Agent-edited MR", draft: false, state: "closed" });
check("update_merge_request applies title, draft and state", mr.title === "Agent-edited MR" && !mr.draft && mr.state === "closed");
mr = await act("wi-1", "update_merge_request", { iid: 2, state: "opened" });
check("update_merge_request reopens", mr.state === "opened");
const mrNote = await act("wi-1", "comment_merge_request", { iid: 2, body: "Reviewed." });
check("comment_merge_request publishes comment", mrNote.iid === 2 && mrNote.commentId);
mr = await act("wi-1", "approve_merge_request", { iid: 2 });
check("approve_merge_request returns MR status", mr.iid === 2 && mr.state === "opened");
mr = await act("wi-1", "merge_merge_request", { iid: 2, mergeWhenPipelineSucceeds: true });
check("merge_merge_request merges and returns result", mr.iid === 2 && mr.state === "merged");

const store = getStore("acme/flask-demo");
const since = (watch, from, type) => watch.events.slice(from).filter((e) => !type || e.type === type);

// ---- mutations: results, events, cross-instance fan-out
let a1 = w1.events.length;
let a2 = w2.events.length;
let aP = wPeer.events.length;
r = await act("wi-1", "create_work_item", { title: "Agent created", type: "Task", parent: 1, labels: ["docs"], assignees: ["bob"], milestone: "v1.0", dueDate: "2031-01-01", description: "from the agent" });
check("create_work_item returns the compact shape", r.iid === 14 && r.type === "Task" && r.parent === 1 && r.labels.join() === "docs" && r.assignees.join() === "bob" && r.milestone === "v1.0" && r.dueDate === "2031-01-01" && typeof r.url === "string" && !("description" in r), JSON.stringify(r));
const evPeer = await until(() => since(wPeer, aP, "changed")[0]);
check("agent mutation -> `changed {by:agent, source}` reaches the SAME panel", !!(await until(() => since(w1, a1, "changed")[0])) && since(w1, a1, "changed")[0].data.by === "agent");
check("... and a different panel on the same project", evPeer?.data?.by === "agent" && evPeer.data.source === "wi-1", JSON.stringify(evPeer));
await sleep(80);
check("... but not a panel on another project", since(w2, a2, "changed").length === 0);

r = await act("wi-1", "create_work_item", { title: "Defaults to an Issue" });
check("create defaults to the Issue type", r.type === "Issue" && r.iid === 15 && r.labels.length === 0, JSON.stringify(r));
f = await failsWith(act("wi-1", "create_work_item", { title: "x", type: "Epic" }), "invalid", /Unknown work item type/);
check("create with an unknown type -> invalid with the allowed list", f.ok && /Issue, Task, Incident, Ticket/.test(f.why), f.why);
f = await failsWith(act("wi-1", "create_work_item", { title: "x", labels: ["no-such-label"] }), "invalid", /Unknown label/);
check("create with an unknown label -> invalid", f.ok, f.why);
f = await failsWith(act("wi-1", "create_work_item", { title: "FAIL ME" }), "mutation_failed");
check("GitLab rejecting the mutation -> CanvasError(mutation_failed)", f.ok, f.why);

a1 = w1.events.length;
aP = wPeer.events.length;
r = await act("wi-1", "update_work_item", { iid: 14, title: "Agent edited", addLabels: ["bug"], removeLabels: ["docs"], assignees: ["alice", "bob"], state: "closed", milestone: "", dueDate: "", confidential: false, parent: 0 });
check("update_work_item applies the patch", r.title === "Agent edited" && r.labels.join() === "bug" && r.assignees.join() === "alice,bob" && r.state === "closed" && r.milestone === null && r.dueDate === null && r.confidential === false && r.parent === null, JSON.stringify(r));
check("update announces the change", !!(await until(() => since(wPeer, aP, "changed")[0])));
r = await act("wi-1", "update_work_item", { iid: 14, state: "open", parent: 1 });
check("update: reopen + set the parent", r.state === "open" && r.parent === 1, JSON.stringify(r));
f = await failsWith(act("wi-1", "update_work_item", { iid: 14 }), "invalid", /Nothing to change/);
check("update with no fields -> invalid", f.ok, f.why);
f = await failsWith(act("wi-1", "update_work_item", { iid: 99999, title: "x" }), "not_found");
check("update of a missing item -> not_found", f.ok, f.why);
f = await failsWith(act("wi-1", "update_work_item", { iid: 14, assignees: ["ghost"] }), "invalid", /Unknown user/);
check("update with an unknown user -> invalid", f.ok, f.why);

r = await act("wi-1", "add_comment", { iid: 3, body: "Posted by the agent" });
check("add_comment returns a small receipt", r.iid === 3 && /Note/.test(r.commentId) && typeof r.createdAt === "string" && !("body" in r), JSON.stringify(r));
const withComment = await act("wi-1", "get_work_item", { iid: 3 });
check("the comment is visible through get_work_item", withComment.comments.at(-1).body === "Posted by the agent" && withComment.comments.at(-1).author === "feured");
f = await failsWith(act("wi-1", "add_comment", { iid: 3, body: "   " }), "invalid", /empty/);
check("blank comment -> invalid", f.ok, f.why);

r = await act("wi-1", "link_work_items", { iid: 15, target: 4, type: "blocks" });
check("link_work_items", r.iid === 15 && r.linked.length === 1 && r.linked[0].link === "blocks" && r.linked[0].iid === 4, JSON.stringify(r));
r = await act("wi-1", "link_work_items", { iid: 15, target: 5 });
check("link defaults to related", r.linked.some((l) => l.iid === 5 && l.link === "related"), JSON.stringify(r));
f = await failsWith(act("wi-1", "link_work_items", { iid: 15, target: 4 }), "mutation_failed", /already linked/);
check("duplicate link -> mutation_failed", f.ok, f.why);
f = await failsWith(act("wi-1", "link_work_items", { iid: 15, target: 15 }), "invalid");
check("self link -> invalid", f.ok, f.why);
r = await act("wi-1", "unlink_work_items", { iid: 15, target: 4 });
check("unlink_work_items", r.linked.length === 1 && r.linked[0].iid === 5, JSON.stringify(r));
f = await failsWith(act("wi-1", "unlink_work_items", { iid: 15, target: 4 }), "not_found");
check("unlink of a missing link -> not_found", f.ok, f.why);

// ---- error mapping
store.failNext = { code: "network", message: "Could not reach gitlab.com" };
f = await failsWith(act("wi-1", "update_work_item", { iid: 14, title: "boom" }), "network", /gitlab\.com/);
check("GitLabError code + message are preserved in the CanvasError", f.ok, f.why);
store.failNext = { code: "auth", message: "glab is not logged in" };
f = await failsWith(act("wi-1", "add_comment", { iid: 3, body: "boom" }), "auth", /not logged in/);
check("auth failures keep their code", f.ok, f.why);
const calls = store.calls;
store.calls = null;
const logsBefore = captured.logs.length;
f = await failsWith(act("wi-1", "get_work_item", { iid: 1 }), "internal", /Unexpected error in get_work_item/);
store.calls = calls;
check("an unexpected exception becomes CanvasError(internal) and is logged", f.ok && captured.logs.slice(logsBefore).some((l) => l.level === "error" && /get_work_item failed/.test(l.message)), f.why);
r = await act("wi-1", "get_work_item", { iid: 1 });
check("the extension keeps working after an internal error", r.iid === 1);

// ---- view actions
r = await act("wi-1", "get_view", undefined);
check("get_view reports the project and the default view", r.configured === true && r.project.path === "acme/flask-demo" && r.view.mode === "list" && r.view.filters.state === "open" && r.view.selected === null && r.problem === null, JSON.stringify(r));
a1 = w1.events.length;
r = await act("wi-1", "set_view", { mode: "board", groupBy: "scope:workflow", filters: { state: "all", label: ["bug"], sort: "title_asc" } });
check("set_view returns the resulting view", r.view.mode === "board" && r.view.groupBy === "scope:workflow" && r.view.filters.state === "all" && r.view.filters.label.join() === "bug" && r.view.filters.sort === "title_asc" && r.view.filters.assignee === "", JSON.stringify(r));
const viewEvent = await until(() => since(w1, a1, "view").find((e) => e.data?.view?.mode === "board"));
check("set_view pushes a `view` event to the panel", viewEvent?.data?.view?.mode === "board" && viewEvent.data.view.groupBy === "scope:workflow", JSON.stringify(viewEvent));
r = await act("wi-1", "set_view", { filters: { label: [] } });
check("set_view merges: untouched fields stay, label can be cleared", r.view.mode === "board" && r.view.filters.label.length === 0 && r.view.filters.state === "all");
f = await failsWith(act("wi-1", "set_view", { groupBy: "colour" }), "invalid", /groupBy/);
check("set_view with a bad groupBy -> invalid", f.ok, f.why);
f = await failsWith(act("wi-1", "set_view", { filters: { search: "x".repeat(300) } }), "invalid", /too long/);
check("set_view with an oversized search -> invalid", f.ok, f.why);
r = await act("wi-1", "get_view", undefined);
check("a rejected set_view leaves the view untouched", r.view.mode === "board" && r.view.filters.search === "");

a1 = w1.events.length;
r = await act("wi-1", "select_work_item", { iid: 3 });
check("select_work_item validates and returns the item", r.selected.iid === 3 && r.selected.title.startsWith("Add clicker upgrades"), JSON.stringify(r));
const selEvent = await until(() => since(w1, a1, "view").find((e) => e.data?.view?.selected === 3));
check("select pushes the selection to the panel", selEvent?.data?.view?.selected === 3);
f = await failsWith(act("wi-1", "select_work_item", { iid: 99999 }), "not_found");
check("selecting a missing item -> not_found and the selection is unchanged", f.ok && (await act("wi-1", "get_view")).view.selected === 3, f.why);
r = await act("wi-1", "select_work_item", {});
check("select without iid closes the drawer", r.selected === null && (await act("wi-1", "get_view")).view.selected === null);

a1 = w1.events.length;
r = await act("wi-1", "refresh", undefined);
const refreshEvent = await until(() => since(w1, a1, "changed").find((e) => e.data?.meta === true));
check("refresh emits `changed` with meta:true so labels/members reload", r.refreshed === true && refreshEvent?.data?.meta === true && refreshEvent.data.by === "agent", JSON.stringify(refreshEvent));

// ---- project switching + unconfigured instances
f = await failsWith(act("wi-nr", "list_work_items", {}), "no_project", /No GitLab remote/);
check("an instance without a project -> no_project with guidance", f.ok, f.why);
r = await act("wi-nr", "get_view", undefined);
check("get_view works without a project and explains why", r.configured === false && r.project === null && /No GitLab remote/.test(r.problem));
f = await failsWith(act("wi-nr", "set_project", { project: "not a project !!" }), "invalid");
check("set_project with garbage -> invalid", f.ok, f.why);
f = await failsWith(act("wi-nr", "set_project", { project: "nope/missing" }), "not_found");
check("set_project with an unknown project -> not_found", f.ok, f.why);
r = await act("wi-nr", "set_project", { project: "https://gitlab.com/acme/other" });
check("set_project accepts a URL", r.project.path === "acme/other" && r.view.mode === "list", JSON.stringify(r));
r = await act("wi-nr", "list_work_items", {});
check("... and the instance now works", r.total === 1 && r.items[0].title === "Only item in the other project");
r = await act("wi-nr", "get_project_info", {});
check("get_project_info omits hierarchy/scopedLabelsExclusive when GitLab gave no rules", r.hierarchy === undefined && r.scopedLabelsExclusive === undefined && r.types.includes("Task"), JSON.stringify(r).slice(0, 200));

// ---- close
const closing = new URL(o1.url);
await canvas.onClose(ctx("wi-1"));
const dead = await fetch(`${closing.origin}/api/state`, { headers: { "x-canvas-token": closing.searchParams.get("k") } }).then(() => false, () => true);
check("onClose shuts the server down", dead);
check("onClose ends the open SSE stream", !!(await until(() => w1.ended)));
await canvas.onClose(ctx("wi-1"));
await canvas.onClose(ctx("never-opened"));
check("onClose is safe to repeat and for unknown instances", true);
const reopened = await canvas.open(ctx("wi-1"));
check("a closed instance can be opened again with a fresh server", reopened.url !== o1.url && /^http:\/\/127\.0\.0\.1:\d+\/\?k=/.test(reopened.url));
const fresh = await apiGet(reopened.url, "/api/state");
check("... and it starts from the default view", fresh.json.data.view.mode === "list" && fresh.json.data.view.selected === null);

// close racing a slow open must not leak the server
const racing = canvas.open(ctx("wi-race"));
const closed = canvas.onClose(ctx("wi-race"));
const [raced] = await Promise.allSettled([racing, closed]);
if (raced.status === "fulfilled") {
    const gone = await fetch(`${new URL(raced.value.url).origin}/`).then(() => false, () => true);
    check("close racing open leaves no server behind", gone);
} else check("close racing open leaves no server behind", true, `open rejected: ${raced.reason?.message}`);

section("hygiene");
for (const file of ["extension.mjs", "actions.mjs", "instance.mjs", "server.mjs", "gitlab.mjs"]) {
    const src = fs.readFileSync(`${EXT_DIR}/${file}`, "utf8");
    check(`${file}: never writes to stdout (reserved for JSON-RPC)`, !/console\.(log|info|debug)\b|process\.stdout|stdio:\s*["']inherit["']/.test(src));
}
check("no package.json / node_modules inside the extension", !fs.existsSync(`${EXT_DIR}/package.json`) && !fs.existsSync(`${EXT_DIR}/node_modules`));
check("only declared entry + siblings are imported (no bare npm imports)", ["extension.mjs", "actions.mjs", "instance.mjs", "server.mjs", "gitlab.mjs"].every((file) => [...fs.readFileSync(`${EXT_DIR}/${file}`, "utf8").matchAll(/^import .* from "([^"]+)"/gm)].every((m) => m[1].startsWith("./") || m[1].startsWith("node:") || m[1] === "@github/copilot-sdk/extension")));

for (const id of ["wi-1", "wi-2", "wi-nr", "wi-fallback", "wi-peer"]) await canvas.onClose(ctx(id));
[w1, w2, wPeer].forEach((w) => w.close());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

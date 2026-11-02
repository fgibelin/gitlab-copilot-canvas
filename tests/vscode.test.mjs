import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createWorkbench } from "../canvas/instance.mjs";
import { startServer } from "../canvas/server.mjs";
import { renderWebview, relayRequest } from "../vscode/webview.mjs";
import { registerTools, toolContributions } from "../vscode/tools.mjs";
import { makeMockService, mockDetect, resetStores } from "./harness/mock-service.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("webview rewrites all assets, restricts CSP and contains no access token", async () => {
    const webview = { cspSource: "https://test.vscode-cdn.net", asWebviewUri: (uri) => `https://test.vscode-cdn.net${uri}` };
    const html = await renderWebview(webview, root, (file) => file);
    assert.match(html, /<title>GitLab<\/title>/);
    assert.ok(!html.includes('src="/js/app.js"'));
    assert.ok(!html.includes('href="/app.css"'));
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /vscode\/theme.css/);
    assert.ok(!html.includes("?k="));
});

test("VS Code bridge uses authenticated HTTP routes and rejects arbitrary destinations", async () => {
    resetStores();
    const workbench = createWorkbench({ instanceId: "bridge-test", cwd: "/tmp/work", detect: mockDetect, makeService: makeMockService });
    const server = await startServer({ workbench, publicDir: pathPublic() });
    try {
        const request = (method, path, body) => relayRequest({ id: randomUUID(), method, path, body }, server);
        const state = await request("GET", "/api/state");
        assert.equal(state.payload.data.project.path, "acme/flask-demo");
        const created = await request("POST", "/api/items", { title: "Via VS Code" });
        assert.equal(created.payload.data.title, "Via VS Code");
        const iid = created.payload.data.iid;
        const updated = await request("PATCH", `/api/items/${iid}`, { state: "closed" });
        assert.equal(updated.payload.data.state, "closed");
        const mergeRequests = await request("GET", "/api/merge-requests");
        assert.equal(mergeRequests.payload.data.items[0].iid, 1);
        const mr = await request("POST", "/api/merge-requests", { title: "Via VS Code", sourceBranch: "feature/vscode", targetBranch: "main" });
        assert.equal(mr.payload.data.iid, 2);
        const mrUpdate = await request("PUT", "/api/merge-requests/2", { state: "closed" });
        assert.equal(mrUpdate.payload.data.state, "closed");
        const mrReopen = await request("PUT", "/api/merge-requests/2", { state: "opened" });
        assert.equal(mrReopen.payload.data.state, "opened");
        const mrComment = await request("POST", "/api/merge-requests/2/comments", { body: "Reviewed through the bridge." });
        assert.equal(mrComment.payload.data.body, "Reviewed through the bridge.");
        const mrApproval = await request("POST", "/api/merge-requests/2/approve", {});
        assert.equal(mrApproval.payload.data.iid, 2);
        const mrMerge = await request("POST", "/api/merge-requests/2/merge", {});
        assert.equal(mrMerge.payload.data.state, "merged");
        const invalid = await request("POST", "/api/project", { project: "invalid" });
        assert.equal(invalid.status, 400);
        for (const destination of ["https://example.com/api/items", "//example.com/api/items", "/js/app.js", "/api/../../etc/passwd"]) {
            await assert.rejects(request("GET", destination), /Invalid canvas request/);
        }
        // Opening a Copilot session is a GitHub Copilot app feature: the VS Code bridge must never relay it.
        await assert.rejects(request("POST", `/api/items/${iid}/session`, {}), /Invalid canvas request/);
        assert.equal(state.payload.data.capabilities.openSession, false);
    } finally { workbench.close(); await server.close(); }
});

test("renderer bridge correlates replies across reloads and delivers live events", async () => {
    const source = (await readFile(new URL("../canvas/public/js/vscode-bridge.js", import.meta.url), "utf8")).replace("export const bridge", "globalThis.bridge");
    const boot = () => {
        const messages = [];
        let receive;
        const context = {
            crypto: { randomUUID }, setTimeout, clearTimeout,
            acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
            window: { addEventListener: (_name, listener) => { receive = listener; } },
        };
        vm.runInNewContext(source, context);
        return { bridge: context.bridge, messages, reply: (data) => receive({ data: { channel: "gitlab-canvas", ...data } }) };
    };
    const first = boot();
    const second = boot();
    const firstResult = first.bridge.request("GET", "/api/state");
    const secondResult = second.bridge.request("GET", "/api/state");
    assert.notEqual(first.messages[0].id, second.messages[0].id);
    first.reply({ id: first.messages[0].id, payload: { ok: true }, status: 200 });
    second.reply({ id: second.messages[0].id, payload: { ok: true }, status: 200 });
    assert.equal((await firstResult).status, 200);
    assert.equal((await secondResult).payload.ok, true);
    const events = [];
    const statuses = [];
    const disconnect = second.bridge.connect((type) => events.push(type), (status) => statuses.push(status));
    second.reply({ type: "event", event: "hello" });
    second.reply({ type: "event", event: "changed" });
    disconnect();
    assert.deepEqual(events, ["hello", "changed"]);
    assert.deepEqual(statuses, ["connecting", "live", "closed"]);
});
const pathPublic = () => fileURLToPath(new URL("../canvas/public/", import.meta.url));

test("all tools register; writes require the selected project and honor cancellation", async () => {
    resetStores();
    const wb = createWorkbench({ instanceId: "tool-test", cwd: "/tmp/work", detect: mockDetect, makeService: makeMockService });
    await wb.init();
    const tools = new Map();
    class TextPart { constructor(value) { this.value = value; } }
    class Result { constructor(content) { this.content = content; } }
    const vscode = {
        workspace: { isTrusted: true }, lm: { registerTool: (name, tool) => { tools.set(name, tool); return { dispose() {} }; } },
        LanguageModelTextPart: TextPart, LanguageModelToolResult: Result, CancellationError: class extends Error {},
    };
    try {
        registerTools(vscode, { subscriptions: [] }, () => ({ workbench: wb }), () => {});
        assert.equal(tools.size, 20);
        assert.equal(toolContributions().length, tools.size);
        const create = tools.get("gitlab_canvas_create_work_item");
        const merge = tools.get("gitlab_canvas_merge_merge_request");
        const cancelled = { isCancellationRequested: true };
        const allowed = { isCancellationRequested: false };
        const input = { title: "Tool-created item", expectedProject: "gitlab.com/acme/flask-demo" };
        assert.match(create.prepareInvocation({ input }).confirmationMessages.message, /gitlab.com\/acme\/flask-demo/);
        assert.match(merge.prepareInvocation({ input: { iid: 1, expectedProject: "gitlab.com/acme/flask-demo" } }).confirmationMessages.message, /gitlab.com\/acme\/flask-demo/);
        await assert.rejects(create.invoke({ input: { ...input, expectedProject: "gitlab.com/wrong/project" } }, allowed), /does not match/);
        await assert.rejects(create.invoke({ input }, cancelled), vscode.CancellationError);
        const result = await create.invoke({ input }, allowed);
        assert.equal(JSON.parse(result.content[0].value).title, input.title);
        const init = wb.init;
        wb.init = async () => { await init(); await wb.setProject("acme/other"); };
        await assert.rejects(create.invoke({ input }, allowed), /does not match/);
        vscode.workspace.isTrusted = false;
        await assert.rejects(create.invoke({ input }, allowed), /Trust this workspace/);
    } finally { wb.close(); }
});

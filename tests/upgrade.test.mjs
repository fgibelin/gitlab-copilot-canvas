import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { loadPublicAssets, startServer } from "../gitlab-copilot-canvas/server.mjs";

test("a running server keeps its UI assets when the installation is upgraded", async (t) => {
    const publicDir = await mkdtemp(path.join(tmpdir(), "gitlab-canvas-upgrade-"));
    t.after(() => rm(publicDir, { recursive: true, force: true }));
    await mkdir(path.join(publicDir, "js"));
    const original = {
        "index.html": '<script type="module" src="/js/app.js"></script>',
        "app.css": "body { color: black; }",
        "js/app.js": 'export const version = "old";',
        "js/removed.js": "export const available = true;",
    };
    for (const [file, body] of Object.entries(original)) await writeFile(path.join(publicDir, file), body);
    const workbench = { instanceId: "upgrade", subscribe: () => () => {} };
    const assets = await loadPublicAssets(publicDir);
    const server = await startServer({ publicDir, assets, workbench });
    t.after(() => server.close());
    const readAsset = async (server, file) => {
        const response = await fetch(new URL(`/${file}`, server.url));
        return { status: response.status, text: await response.text() };
    };

    await writeFile(path.join(publicDir, "index.html"), "<h1>New UI</h1>");
    await writeFile(path.join(publicDir, "app.css"), "body { color: blue; }");
    await writeFile(path.join(publicDir, "js/app.js"), 'export const version = "new";');
    await writeFile(path.join(publicDir, "js/new.js"), "export const newFeature = true;");
    await rm(path.join(publicDir, "js/removed.js"));

    for (const [file, body] of Object.entries(original)) {
        assert.deepEqual(await readAsset(server, file), { status: 200, text: body }, file);
    }
    assert.equal((await readAsset(server, "js/new.js")).status, 404);
    assert.deepEqual(await readAsset(server, ""), { status: 200, text: original["index.html"] });

    const anotherPanel = await startServer({ publicDir, assets, workbench });
    t.after(() => anotherPanel.close());
    assert.deepEqual(await readAsset(anotherPanel, "js/app.js"), { status: 200, text: original["js/app.js"] });
    assert.equal((await readAsset(anotherPanel, "js/new.js")).status, 404);

    const restarted = await startServer({ publicDir, workbench });
    t.after(() => restarted.close());
    assert.deepEqual(await readAsset(restarted, "js/app.js"), { status: 200, text: 'export const version = "new";' });
    assert.equal((await readAsset(restarted, "js/new.js")).status, 200);
    assert.equal((await readAsset(restarted, "js/removed.js")).status, 404);
});

test("missing required UI assets fail server startup", async (t) => {
    const publicDir = await mkdtemp(path.join(tmpdir(), "gitlab-canvas-incomplete-"));
    t.after(() => rm(publicDir, { recursive: true, force: true }));
    const workbench = { instanceId: "incomplete", subscribe: () => () => {} };
    let server;
    t.after(() => server?.close());
    await assert.rejects(async () => { server = await startServer({ publicDir, workbench }); }, { code: "ENOENT" });
});

const apiSource = (await readFile(new URL("../gitlab-copilot-canvas/public/js/api.js", import.meta.url), "utf8"))
    .replace('import { bridge } from "./vscode-bridge.js";', "const bridge = globalThis.testBridge;")
    .replaceAll("export ", "");

function client({ vscode, status, payload }) {
    const requests = [];
    const context = {
        URL, URLSearchParams,
        location: { href: "http://127.0.0.1:1234/?k=test-token", search: "?k=test-token" },
        testBridge: vscode ? {
            request: async (...args) => { requests.push(args); return { status, payload }; },
        } : null,
        fetch: async (...args) => { requests.push(args); return { status, json: async () => payload }; },
    };
    vm.runInNewContext(`${apiSource}\nglobalThis.api = api;`, context);
    return { api: context.api, requests };
}

for (const vscode of [false, true]) {
    const host = vscode ? "VS Code" : "Copilot App";
    test(`${host}: unsupported merge request routes explain how to restart the extension`, async () => {
        const { api, requests } = client({ vscode, status: 404, payload: { ok: false, error: { code: "not_found", message: "Unknown endpoint." } } });
        for (const request of [() => api.mergeRequests(), () => api.createMergeRequest({ title: "Test", sourceBranch: "feature", targetBranch: "main" })]) {
            await assert.rejects(request, (error) => {
                assert.equal(error.code, "outdated_server");
                assert.equal(error.status, 404);
                assert.match(error.message, vscode ? /reload.*VS Code window/i : /new Copilot session/i);
                assert.match(error.message, /reopen/i);
                assert.match(error.message, /refreshing.*not enough/i);
                return true;
            });
        }
        assert.equal(requests.length, 2, "failed writes must not be retried automatically");
    });

    test(`${host}: GitLab errors are not mistaken for an outdated server`, async () => {
        for (const failure of [
            { status: 404, code: "not_found", message: "Merge request !42 does not exist." },
            { status: 403, code: "forbidden", message: "Insufficient permission." },
            { status: 502, code: "auth", message: "glab is not authenticated." },
        ]) {
            const { api } = client({ vscode, status: failure.status, payload: { ok: false, error: failure } });
            await assert.rejects(api.mergeRequest(42), { code: failure.code, message: failure.message, status: failure.status });
        }
    });

    test(`${host}: supported merge request routes return their data`, async () => {
        const data = { items: [{ iid: 42 }], hasNextPage: false, nextPage: null };
        const { api } = client({ vscode, status: 200, payload: { ok: true, data } });
        assert.deepEqual(await api.mergeRequests(), data);
    });
}

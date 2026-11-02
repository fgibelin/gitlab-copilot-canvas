const vscode = require("vscode");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let active = null;
let opening = null;

exports.activate = async (context) => {
    const load = (relative) => import(pathToFileURL(path.join(context.extensionPath, relative)).href);
    const [{ createWorkbench }, { startServer }, { renderWebview, relayRequest }, { registerTools }] = await Promise.all([
        load("gitlab-copilot-canvas/instance.mjs"), load("gitlab-copilot-canvas/server.mjs"), load("vscode/webview.mjs"), load("vscode/tools.mjs"),
    ]);
    const output = vscode.window.createOutputChannel("GitLab Work Items");
    const log = (level, message) => output.appendLine(`[${level}] ${message}`);
    context.subscriptions.push(output);
    const current = () => {
        if (!active) throw new Error("Open 'GitLab: Open GitLab Project Canvas' from the Command Palette first.");
        return active;
    };
    async function open() {
        if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before running GitLab CLI operations.");
        if (active) return active.panel.reveal();
        const folders = vscode.workspace.workspaceFolders ?? [];
        const folder = folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the GitLab repository" }) : folders[0];
        if (folders.length > 1 && !folder) return;
        const workbench = createWorkbench({ instanceId: "vscode-work-items", cwd: folder?.uri.fsPath });
        let server;
        let panel;
        let ready;
        let rejectReady;
        let readyTimer;
        try {
            await workbench.init();
            server = await startServer({ publicDir: path.join(context.extensionPath, "gitlab-copilot-canvas/public"), workbench, log });
            panel = vscode.window.createWebviewPanel("gitlabWorkItems", "GitLab", vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "gitlab-copilot-canvas/public"), vscode.Uri.joinPath(context.extensionUri, "vscode")],
            });
            const entry = { panel, workbench, server };
            active = entry;
            const unsubscribe = workbench.subscribe(({ type, data }) => {
                panel.webview.postMessage({ channel: "gitlab-canvas", type: "event", event: type, data }).then(undefined, error => log("warning", error.message));
            });
            panel.webview.onDidReceiveMessage(async (message) => {
                if (message?.channel !== "gitlab-canvas") return;
                if (message.type === "subscribe") {
                    await panel.webview.postMessage({ channel: "gitlab-canvas", type: "event", event: "hello", data: { instanceId: workbench.instanceId } });
                    ready?.();
                    return;
                }
                if (message.type !== "request") return;
                let result;
                try {
                    if (!vscode.workspace.isTrusted) throw new Error("Workspace is not trusted.");
                    result = await relayRequest(message, server);
                } catch (error) {
                    log("error", error.stack ?? error.message);
                    result = { status: 500, payload: { ok: false, error: { code: "bridge_error", message: error.message } } };
                }
                if (active === entry) await panel.webview.postMessage({ channel: "gitlab-canvas", id: message.id, ...result });
            }, undefined, context.subscriptions);
            panel.onDidDispose(() => {
                unsubscribe();
                rejectReady?.(new Error("Canvas closed before its renderer was ready."));
                workbench.close();
                if (active === entry) active = null;
                server.close().catch(error => log("error", error.message));
            });
            const html = await renderWebview(panel.webview, context.extensionPath, vscode.Uri.file);
            const rendererReady = new Promise((resolve, reject) => {
                ready = resolve;
                rejectReady = reject;
                readyTimer = setTimeout(() => reject(new Error("Canvas renderer did not start. See the GitLab Work Items output log.")), 30_000);
            });
            panel.webview.html = html;
            await rendererReady;
            return workbench.describe();
        } catch (error) {
            panel?.dispose();
            workbench.close();
            await server?.close();
            throw error;
        } finally {
            clearTimeout(readyTimer);
            ready = rejectReady = null;
        }
    }
    context.subscriptions.push(vscode.commands.registerCommand("gitlabCanvas.open", async () => {
        opening ??= open().finally(() => { opening = null; });
        try { return await opening; }
        catch (error) {
            log("error", error.stack ?? error.message);
            await vscode.window.showErrorMessage(`GitLab canvas: ${error.message}`);
        }
    }));
    registerTools(vscode, context, current, log);
};

exports.deactivate = async () => {
    const entry = active;
    active = null;
    entry?.workbench.close();
    entry?.panel.dispose();
    await entry?.server.close();
};

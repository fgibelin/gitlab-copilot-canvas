import { readFile } from "node:fs/promises";
import path from "node:path";

const escape = (text) => String(text).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function renderWebview(webview, root, uriFile) {
    const asset = (relative) => escape(webview.asWebviewUri(uriFile(path.join(root, relative))).toString());
    const html = await readFile(path.join(root, "canvas/public/index.html"), "utf8");
    const policy = `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src https: data:; font-src ${webview.cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';`;
    return html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${escape(policy)}">`)
        .replace('href="/app.css"', `href="${asset("canvas/public/app.css")}"`)
        .replace("</head>", `<link rel="stylesheet" href="${asset("vscode/theme.css")}">\n</head>`)
        .replace('src="/js/app.js"', `src="${asset("canvas/public/js/app.js")}"`);
}

export async function relayRequest(message, server) {
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    if (typeof message.id !== "string" || !/^[0-9a-f-]{36}$/.test(message.id) || !methods.includes(message.method) || typeof message.path !== "string" ||
        !/^\/api\/(?:state|project|meta|view|items(?:\/\d+(?:\/(?:comments|links(?:\/\d+)?))?)?)$/.test(message.path)) {
        throw new Error("Invalid canvas request");
    }
    if (JSON.stringify(message).length > 1024 * 1024) throw new Error("Canvas request exceeds 1 MiB");
    const url = new URL(message.path, server.url);
    for (const [key, values] of Object.entries(message.query ?? {})) {
        for (const value of Array.isArray(values) ? values : [values]) {
            if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
        }
    }
    const response = await fetch(url, {
        method: message.method,
        headers: { "x-canvas-token": server.token, "content-type": "application/json" },
        body: message.body === undefined ? undefined : JSON.stringify(message.body),
    });
    return { status: response.status, payload: await response.json() };
}

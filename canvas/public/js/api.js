// Talks to the extension's loopback server. The per-panel token comes from the URL the host opened (`?k=`).
import { bridge } from "./vscode-bridge.js";

const search = new URLSearchParams(location.search);
export const token = search.get("k") ?? "";
export const authorized = Boolean(token || bridge);

export class ApiError extends Error {
    constructor(code, message, status = 0) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
    }
}

function responseData(status, payload) {
    if (!payload?.ok) {
        if (status === 404 && payload?.error?.code === "not_found" && payload.error.message === "Unknown endpoint.") {
            const restart = bridge ? "Reload the VS Code window" : "Start a new Copilot session";
            throw new ApiError("outdated_server", `This canvas is using an older extension server. ${restart}, then reopen the GitLab canvas. Refreshing this panel is not enough.`, status);
        }
        throw new ApiError(payload?.error?.code ?? "error", payload?.error?.message ?? "The request failed.", status);
    }
    return payload.data;
}

async function request(method, path, { query, body } = {}) {
    if (bridge) {
        const { status, payload } = await bridge.request(method, path, query, body);
        return responseData(status, payload);
    }
    if (!token) throw new ApiError("no_token", "This page was opened without its access token. Reopen the canvas from the Copilot app.", 0);
    const url = new URL(path, location.href);
    for (const [key, value] of Object.entries(query ?? {})) {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (item !== undefined && item !== null && item !== "") url.searchParams.append(key, String(item));
        }
    }
    const headers = { "x-canvas-token": token };
    if (body !== undefined) headers["content-type"] = "application/json";

    let response;
    try {
        response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    } catch {
        throw new ApiError("network", "Could not reach the canvas server. It may have been restarted: reopen the canvas.");
    }
    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new ApiError("bad_response", `Unexpected response from the canvas server (HTTP ${response.status}).`, response.status);
    }
    return responseData(response.status, payload);
}

export const api = {
    state: () => request("GET", "/api/state"),
    setProject: (project) => request("POST", "/api/project", { body: { project } }),
    meta: (force = false) => request("GET", "/api/meta", { query: force ? { force: 1 } : {} }),
    items: (filters, { first, after } = {}) => request("GET", "/api/items", { query: { ...filters, first, after } }),
    item: (iid) => request("GET", `/api/items/${iid}`),
    mergeRequests: (filters = {}, paging = {}) => request("GET", "/api/merge-requests", { query: { ...filters, ...paging } }),
    mergeRequest: (iid) => request("GET", `/api/merge-requests/${iid}`),
    create: (data) => request("POST", "/api/items", { body: data }),
    update: (iid, patch) => request("PATCH", `/api/items/${iid}`, { body: patch }),
    comment: (iid, body) => request("POST", `/api/items/${iid}/comments`, { body: { body } }),
    link: (iid, target, type) => request("POST", `/api/items/${iid}/links`, { body: { target, type } }),
    unlink: (iid, target) => request("DELETE", `/api/items/${iid}/links/${target}`),
    createMergeRequest: (data) => request("POST", "/api/merge-requests", { body: data }),
    updateMergeRequest: (iid, patch) => request("PUT", `/api/merge-requests/${iid}`, { body: patch }),
    commentMergeRequest: (iid, body) => request("POST", `/api/merge-requests/${iid}/comments`, { body: { body } }),
    approveMergeRequest: (iid) => request("POST", `/api/merge-requests/${iid}/approve`, { body: {} }),
    mergeMergeRequest: (iid, options = {}) => request("POST", `/api/merge-requests/${iid}/merge`, { body: options }),
    setView: (patch) => request("PUT", "/api/view", { body: patch }),
};

/** Opens the SSE stream. Returns a function that closes it. */
export function connectEvents(onEvent, onStatus) {
    if (bridge) return bridge.connect(onEvent, onStatus);
    if (!token) {
        onStatus("closed");
        return () => {};
    }
    const source = new EventSource(`/events?k=${encodeURIComponent(token)}`);
    source.addEventListener("open", () => onStatus("live"));
    source.addEventListener("error", () => onStatus(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting"));
    for (const type of ["hello", "changed", "view", "project"]) {
        source.addEventListener(type, (event) => {
            let data = null;
            try {
                data = JSON.parse(event.data);
            } catch {
                /* ignore malformed payloads */
            }
            onEvent(type, data);
        });
    }
    return () => source.close();
}

// VS Code owns this bridge; Copilot App continues to use HTTP and SSE.
function createBridge() {
    const host = acquireVsCodeApi();
    const pending = new Map();
    let events = null;
    window.addEventListener("message", ({ data }) => {
        if (data?.channel !== "gitlab-canvas") return;
        if (data.type === "event") {
            events?.(data.event, data.data);
            return;
        }
        const call = pending.get(data.id);
        if (!call) return;
        pending.delete(data.id);
        clearTimeout(call.timer);
        call.resolve(data);
    });
    return {
        request(method, path, query, body) {
            return new Promise((resolve, reject) => {
                const id = crypto.randomUUID();
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error("The extension did not respond. A write may have completed; refresh before retrying."));
                }, 180_000);
                pending.set(id, { resolve, timer });
                host.postMessage({ channel: "gitlab-canvas", type: "request", id, method, path, query, body });
            });
        },
        connect(onEvent, onStatus) {
            events = (event, data) => {
                if (event === "hello") onStatus("live");
                onEvent(event, data);
            };
            onStatus("connecting");
            host.postMessage({ channel: "gitlab-canvas", type: "subscribe" });
            return () => { events = null; onStatus("closed"); };
        },
    };
}

export const bridge = typeof acquireVsCodeApi === "function" ? createBridge() : null;

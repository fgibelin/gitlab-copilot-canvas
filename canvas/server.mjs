// Loopback HTTP server behind one canvas panel: static UI, a small JSON API and a Server-Sent-Events stream.
//
// The server only listens on 127.0.0.1, but any web page open in the user's browser can still send requests to
// loopback ports. So every API/SSE call needs a random per-instance token (known only to the panel URL), the Host
// header must be a loopback name (anti DNS-rebinding), and a browser Origin must be loopback or opaque.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GitLabError } from "./gitlab.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SSE_CLIENTS = 8;
const HEARTBEAT_MS = 25_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

// Scripts and network access are locked to this origin; styles, fonts and images stay open so the host's
// injected theme (stylesheets, web fonts) and GitLab avatars keep working.
const CSP = "script-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const digest = (value) => createHash("sha256").update(String(value)).digest();

function statusFor(error) {
    if (error instanceof HttpError) return error.status;
    if (!(error instanceof GitLabError)) return 500;
    switch (error.code) {
        case "invalid":
            return 400;
        case "not_found":
            return 404;
        case "forbidden":
            return 403;
        case "no_project":
            return 409;
        default:
            return 502;
    }
}

function hostnameOf(hostHeader) {
    return String(hostHeader ?? "").toLowerCase().replace(/:\d+$/, "");
}

function originAllowed(origin) {
    if (origin === undefined || origin === "null") return true;
    try {
        const url = new URL(origin);
        return url.protocol === "http:" && LOOPBACK.has(url.hostname === "::1" ? "[::1]" : url.hostname);
    } catch {
        return false;
    }
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) tooLarge = true;
            else chunks.push(chunk);
        });
        req.on("error", reject);
        req.on("end", () => {
            if (tooLarge) return reject(new HttpError(413, "too_large", "The request body is too large."));
            if (!chunks.length) return resolve({});
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
                resolve(body);
            } catch {
                reject(new HttpError(400, "invalid_json", "The request body must be a JSON object."));
            }
        });
    });
}

function filterFromQuery(query) {
    const get = (name) => query.get(name) ?? undefined;
    const types = query.getAll("type");
    return { state: get("state"), type: types.length > 1 ? types : types[0], label: query.getAll("label"), assignee: get("assignee"), milestone: get("milestone"), search: get("search"), sort: get("sort") };
}

/**
 * Starts the server for one workbench.
 * @returns {{ url: string, port: number, token: string, close(): Promise<void> }}
 */
export async function startServer({ publicDir, workbench, log = () => {} }) {
    const root = path.resolve(publicDir);
    const token = randomBytes(16).toString("hex");
    const expectedDigest = digest(token);
    const clients = new Set();

    const tokenValid = (value) => typeof value === "string" && timingSafeEqual(digest(value), expectedDigest);
    const corsFor = (req) => (req.headers.origin && originAllowed(req.headers.origin) ? { "Access-Control-Allow-Origin": req.headers.origin, Vary: "Origin" } : {});

    function send(res, status, body, headers = {}) {
        res.writeHead(status, { ...BASE_HEADERS, ...headers });
        res.end(body);
    }
    const sendJson = (res, status, payload, headers = {}) => send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8", ...headers });

    async function serveFile(res, relative, headers) {
        const absolute = path.resolve(root, relative);
        const type = MIME[path.extname(absolute).toLowerCase()];
        if (!type || !absolute.startsWith(root + path.sep)) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
        let body;
        try {
            body = await readFile(absolute);
        } catch {
            return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
        }
        send(res, 200, body, { "Content-Type": type, ...headers });
    }

    function sendEvent(res, type, data) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    function openEventStream(req, res) {
        if (clients.size >= MAX_SSE_CLIENTS) {
            const oldest = clients.values().next().value;
            clients.delete(oldest);
            oldest.end();
        }
        res.writeHead(200, {
            ...BASE_HEADERS,
            ...corsFor(req),
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write("retry: 3000\n\n");
        sendEvent(res, "hello", { instanceId: workbench.instanceId });
        clients.add(res);
        req.on("close", () => clients.delete(res));
    }

    const routes = [
        ["GET", /^\/api\/state$/, async () => workbench.describe()],
        ["POST", /^\/api\/project$/, async ({ body }) => workbench.setProject(body.project)],
        ["GET", /^\/api\/meta$/, async ({ query }) => workbench.meta({ force: query.get("force") === "1" })],
        ["GET", /^\/api\/items$/, async ({ query }) => workbench.list(filterFromQuery(query), { first: Number(query.get("first")) || 50, after: query.get("after") || undefined })],
        ["POST", /^\/api\/items$/, async ({ body }) => workbench.create(body)],
        ["GET", /^\/api\/items\/(\d+)$/, async ({ params }) => workbench.get(params[0])],
        ["PATCH", /^\/api\/items\/(\d+)$/, async ({ params, body }) => workbench.update(params[0], body)],
        ["POST", /^\/api\/items\/(\d+)\/comments$/, async ({ params, body }) => workbench.comment(params[0], body.body)],
        ["POST", /^\/api\/items\/(\d+)\/links$/, async ({ params, body }) => workbench.link(params[0], body.target, body.type)],
        ["DELETE", /^\/api\/items\/(\d+)\/links\/(\d+)$/, async ({ params }) => workbench.unlink(params[0], params[1])],
        ["PUT", /^\/api\/view$/, async ({ body }) => workbench.setView(body)],
    ];

    async function handleApi(req, res, url) {
        const cors = corsFor(req);
        const known = routes.filter(([, pattern]) => pattern.test(url.pathname));
        if (!known.length) throw new HttpError(404, "not_found", "Unknown endpoint.");
        const route = known.find(([method]) => method === req.method);
        if (!route) throw new HttpError(405, "method_not_allowed", `${req.method} is not supported here.`);
        let body = {};
        if (["POST", "PUT", "PATCH"].includes(req.method)) {
            if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "unsupported_media_type", "Send JSON with Content-Type: application/json.");
            body = await readJson(req);
        }
        await workbench.init();
        const params = url.pathname.match(route[1]).slice(1);
        const data = await route[2]({ params, body, query: url.searchParams });
        sendJson(res, 200, { ok: true, data: data ?? null }, cors);
    }

    async function onRequest(req, res) {
        try {
            if (!LOOPBACK.has(hostnameOf(req.headers.host))) return send(res, 403, "Forbidden host", { "Content-Type": "text/plain; charset=utf-8" });
            const url = new URL(req.url ?? "/", "http://localhost");
            const { pathname } = url;
            const isApi = pathname.startsWith("/api/");
            const isEvents = pathname === "/events";

            if (isApi || isEvents) {
                if (!originAllowed(req.headers.origin)) throw new HttpError(403, "bad_origin", "This origin may not use the canvas API.");
                if (req.method === "OPTIONS") {
                    return send(res, 204, "", {
                        ...corsFor(req),
                        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
                        "Access-Control-Allow-Headers": "content-type, x-canvas-token",
                        "Access-Control-Max-Age": "600",
                    });
                }
                const provided = req.headers["x-canvas-token"] ?? (isEvents ? url.searchParams.get("k") : undefined);
                if (!tokenValid(provided)) throw new HttpError(403, "bad_token", "Missing or invalid canvas token. Reopen the canvas.");
                if (isEvents) {
                    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
                    return openEventStream(req, res);
                }
                return await handleApi(req, res, url);
            }

            if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
            if (pathname === "/" || pathname === "/index.html") return await serveFile(res, "index.html", { "Content-Security-Policy": CSP });
            if (pathname === "/app.css" || pathname.startsWith("/js/")) {
                let relative;
                try {
                    relative = decodeURIComponent(pathname.slice(1));
                } catch {
                    throw new HttpError(404, "not_found", "Not found.");
                }
                // Assets are public code. CORS keeps module scripts loadable even if the host embeds the page in an opaque origin.
                return await serveFile(res, relative, { "Access-Control-Allow-Origin": "*" });
            }
            throw new HttpError(404, "not_found", "Not found.");
        } catch (error) {
            if (res.headersSent) return res.destroy();
            const status = statusFor(error);
            const known = error instanceof HttpError || error instanceof GitLabError;
            if (!known) log("error", `Unhandled error: ${error?.stack ?? error}`);
            const payload = { ok: false, error: { code: known ? error.code : "internal", message: known ? error.message : "Unexpected error in the canvas server." } };
            if (error instanceof HttpError && error.status === 413) res.once("finish", () => req.destroy());
            sendJson(res, status, payload, corsFor(req));
        }
    }

    const server = createServer((req, res) => {
        onRequest(req, res).catch((error) => {
            log("error", `Request failed: ${error?.stack ?? error}`);
            if (!res.writableEnded) res.destroy();
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();

    const unsubscribe = workbench.subscribe(({ type, data }) => {
        for (const client of clients) {
            try {
                sendEvent(client, type, data);
            } catch {
                clients.delete(client);
            }
        }
    });
    const heartbeat = setInterval(() => {
        for (const client of clients) {
            try {
                client.write(": ping\n\n");
            } catch {
                clients.delete(client);
            }
        }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    return {
        url: `http://127.0.0.1:${port}/?k=${token}`,
        port,
        token,
        async close() {
            unsubscribe();
            clearInterval(heartbeat);
            for (const client of clients) client.end();
            clients.clear();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

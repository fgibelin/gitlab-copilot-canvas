// GitLab project canvas: work items and merge requests for the project behind the session's git remote.
//
// One workbench (state + GitLab access) and one loopback server per open panel. The panel UI lives in ./public; the
// agent drives the same workbench through the actions in ./actions.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { buildActions } from "./actions.mjs";
import { createWorkbench } from "./instance.mjs";
import { launchWorktreeSession } from "./issue-session.mjs";
import { loadPublicAssets, startServer } from "./server.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PUBLIC_ASSETS = await loadPublicAssets(PUBLIC_DIR);

let session = null;

// stdout belongs to the JSON-RPC channel, so diagnostics go through the session log (and stderr for errors).
function log(level, message) {
    if (level === "error") console.error(`[gitlab-work-items] ${message}`);
    session?.log(message, { level, ephemeral: true }).catch(() => {});
}

/** instanceId -> { workbench, server, starting } */
const entries = new Map();

const workingDirectory = (ctx) => ctx.session?.workingDirectory ?? process.cwd();

function entryFor(ctx, input = {}) {
    let entry = entries.get(ctx.instanceId);
    if (!entry) {
        // `session` is read when the button is clicked, long after joinSession has returned.
        const launchSession = (request) => launchWorktreeSession(session, request, { log });
        entry = { workbench: createWorkbench({ instanceId: ctx.instanceId, cwd: workingDirectory(ctx), input, launchSession }), server: null, starting: null };
        entries.set(ctx.instanceId, entry);
    }
    return entry;
}

// Several `open` calls can arrive together (host re-open, provider reconnect); they must share one server.
function ensureServer(entry) {
    if (entry.server) return Promise.resolve(entry.server);
    entry.starting ??= startServer({ publicDir: PUBLIC_DIR, assets: PUBLIC_ASSETS, workbench: entry.workbench, log })
        .then((server) => {
            entry.server = server;
            return server;
        })
        .finally(() => {
            entry.starting = null;
        });
    return entry.starting;
}

async function disposeEntry(instanceId) {
    const entry = entries.get(instanceId);
    if (!entry) return;
    entries.delete(instanceId);
    entry.workbench.close();
    const server = entry.server ?? (await entry.starting?.catch(() => null)) ?? null;
    await server?.close();
}

const canvas = createCanvas({
    id: "gitlab-work-items",
    displayName: "GitLab",
    description: "Browse and manage this GitLab project's work items and merge requests, including merge request discussion, approval and merge.",
    inputSchema: {
        type: "object",
        properties: { project: { type: "string", maxLength: 300, description: "GitLab project as group/project or a project URL. Defaults to the GitLab remote of the session's repository." } },
    },
    actions: buildActions({ workbenchFor: (ctx) => entryFor(ctx).workbench, log, ErrorClass: CanvasError }),

    open: async (ctx) => {
        const entry = entryFor(ctx, ctx.input && typeof ctx.input === "object" ? ctx.input : {});
        let server;
        try {
            server = await ensureServer(entry);
        } catch (error) {
            log("error", `Could not start the canvas server: ${error?.stack ?? error}`);
            throw new CanvasError("server_failed", `Could not start the canvas server: ${error?.message ?? error}`);
        }
        await entry.workbench.init();
        const { project } = entry.workbench.describe();
        return { url: server.url, title: "GitLab", status: project?.path ?? "No project selected" };
    },

    onClose: async (ctx) => {
        await disposeEntry(ctx.instanceId).catch((error) => log("warning", `Closing ${ctx.instanceId} failed: ${error?.message ?? error}`));
    },
});

session = await joinSession({ canvases: [canvas] });
log("info", "GitLab canvas ready.");

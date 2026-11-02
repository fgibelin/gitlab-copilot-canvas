// Per-canvas-instance state: which GitLab project is shown, the view the user (or the agent) set up, and
// change notifications. The HTTP server and the agent actions both go through this one object.
import { GitLabError, SORTS, createService, detectProject, parseIid, parseProjectRef } from "./gitlab.mjs";

const invalid = (message) => new GitLabError("invalid", message);

export const DEFAULT_VIEW = Object.freeze({
    mode: "list",
    groupBy: "state",
    filters: Object.freeze({ state: "open", type: "", label: Object.freeze([]), assignee: "", milestone: "", search: "", sort: "updated_desc" }),
    selected: null,
});

const GROUP_RE = /^(state|assignee|milestone|scope:[^\s:][^:]{0,79})$/;

function text(value, field, max = 200) {
    const s = String(value ?? "").trim();
    if (s.length > max) throw invalid(`${field} is too long (max ${max} characters).`);
    return s;
}

/** Applies a partial view patch onto a view, validating every field. */
export function mergeView(current, patch = {}) {
    const next = { mode: current.mode, groupBy: current.groupBy, filters: { ...current.filters, label: [...current.filters.label] }, selected: current.selected };
    if (patch.mode !== undefined) {
        if (patch.mode !== "list" && patch.mode !== "board") throw invalid('mode must be "list" or "board".');
        next.mode = patch.mode;
    }
    if (patch.groupBy !== undefined) {
        if (!GROUP_RE.test(String(patch.groupBy))) throw invalid('groupBy must be "state", "assignee", "milestone" or "scope:<label scope>".');
        next.groupBy = String(patch.groupBy);
    }
    const f = patch.filters;
    if (f && typeof f === "object") {
        if (f.state !== undefined) {
            if (!["open", "closed", "all"].includes(f.state)) throw invalid('filters.state must be "open", "closed" or "all".');
            next.filters.state = f.state;
        }
        if (f.sort !== undefined) {
            if (!(f.sort in SORTS)) throw invalid(`filters.sort must be one of ${Object.keys(SORTS).join(", ")}.`);
            next.filters.sort = f.sort;
        }
        for (const key of ["type", "assignee", "milestone", "search"]) if (f[key] !== undefined) next.filters[key] = text(f[key], `filters.${key}`);
        if (f.label !== undefined) {
            const labels = (Array.isArray(f.label) ? f.label : [f.label]).map((l) => text(l, "filters.label", 255)).filter(Boolean);
            if (labels.length > 20) throw invalid("At most 20 label filters are supported.");
            next.filters.label = labels;
        }
    }
    if (patch.selected !== undefined) next.selected = patch.selected === null || patch.selected === "" ? null : parseIid(patch.selected);
    return next;
}

const registry = new Set();

/**
 * Creates the workbench for one canvas instance.
 * `detect`/`makeService` are injectable so tests can run without git or glab.
 */
export function createWorkbench({ instanceId, cwd, input = {}, detect = detectProject, makeService = createService }) {
    let project = null;
    let service = null;
    let problem = null;
    let detectedHost = null;
    let view = structuredClone(DEFAULT_VIEW);
    let ready = null;
    let closed = false;
    const listeners = new Set();

    const projectKey = () => (project ? `${project.host}/${project.path}`.toLowerCase() : null);
    const emit = (type, data) => {
        for (const listener of [...listeners]) {
            try {
                listener({ type, data });
            } catch {
                /* a broken listener must not affect the others */
            }
        }
    };
    const activate = (ref) => {
        project = { host: ref.host, path: ref.path };
        service = makeService({ host: ref.host, projectPath: ref.path });
        problem = null;
    };
    const describe = () => ({ instanceId, configured: Boolean(service), project, problem, view: structuredClone(view) });

    function init() {
        ready ??= (async () => {
            const detected = await detect(cwd).catch(() => null);
            detectedHost = detected?.host ?? null;
            const wanted = String(input?.project ?? "").trim();
            if (wanted) {
                const ref = parseProjectRef(wanted, detectedHost ?? "gitlab.com");
                if (ref) activate(ref);
                else problem = `"${wanted}" is not a GitLab project. Use group/project or paste the project URL.`;
            } else if (detected) {
                activate(detected);
            } else {
                problem = "No GitLab remote was found for this session. Enter the project to manage (group/project or a project URL).";
            }
        })();
        return ready;
    }

    function requireService() {
        if (!service) throw new GitLabError("no_project", problem ?? "No GitLab project is selected.");
        return service;
    }

    function announce(by) {
        const key = projectKey();
        if (!key) return;
        for (const other of registry) if (other.projectKey() === key) other.emit("changed", { by, source: instanceId });
    }

    const mutate = async (by, fn) => {
        const result = await fn(requireService());
        announce(by);
        return result;
    };

    const workbench = {
        instanceId,
        projectKey,
        emit,
        init,
        describe,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getView: () => structuredClone(view),

        /** Updates the view; `broadcast` tells open UIs to adopt it (used for agent-driven changes). */
        setView(patch, { broadcast = false } = {}) {
            view = mergeView(view, patch);
            if (broadcast) emit("view", { view: structuredClone(view) });
            return structuredClone(view);
        },

        async setProject(value) {
            await init();
            const ref = parseProjectRef(value, project?.host ?? detectedHost ?? "gitlab.com");
            if (!ref) throw invalid(`"${String(value ?? "").trim()}" is not a GitLab project. Use group/project or paste the project URL.`);
            const candidate = makeService({ host: ref.host, projectPath: ref.path });
            await candidate.meta({ force: true });
            project = { host: ref.host, path: ref.path };
            service = candidate;
            problem = null;
            view = { ...structuredClone(DEFAULT_VIEW), mode: view.mode };
            emit("project", describe());
            return describe();
        },

        meta: async (options) => requireService().meta(options),
        list: async (filter, page) => requireService().list(filter, page),
        get: async (iid) => requireService().get(iid),
        listMergeRequests: async (filter, page) => requireService().listMergeRequests(filter, page),
        getMergeRequest: async (iid) => requireService().getMergeRequest(iid),
        // `by` ("ui" or "agent") lets other open panels tell who made a change.
        create: (data, by = "ui") => mutate(by, (svc) => svc.create(data)),
        update: (iid, patch, by = "ui") => mutate(by, (svc) => svc.update(iid, patch)),
        comment: (iid, body, by = "ui") => mutate(by, (svc) => svc.comment(iid, body)),
        link: (iid, target, type, by = "ui") => mutate(by, (svc) => svc.link(iid, target, type)),
        unlink: (iid, target, by = "ui") => mutate(by, (svc) => svc.unlink(iid, target)),
        createMergeRequest: (data, by = "ui") => mutate(by, (svc) => svc.createMergeRequest(data)),
        updateMergeRequest: (iid, patch, by = "ui") => mutate(by, (svc) => svc.updateMergeRequest(iid, patch)),
        commentMergeRequest: (iid, body, by = "ui") => mutate(by, (svc) => svc.commentMergeRequest(iid, body)),
        approveMergeRequest: (iid, by = "ui") => mutate(by, (svc) => svc.approveMergeRequest(iid)),
        mergeMergeRequest: (iid, options, by = "ui") => mutate(by, (svc) => svc.mergeMergeRequest(iid, options)),

        close() {
            closed = true;
            registry.delete(workbench);
            listeners.clear();
        },
        get closed() {
            return closed;
        },
    };
    registry.add(workbench);
    return workbench;
}

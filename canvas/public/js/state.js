// Client-side store and controller. Components read `state` and call the exported actions; every change is announced
// on a topic ("phase", "view", "meta", "items", "detail", "status") so each region re-renders only what it needs.
import { api, ApiError, connectEvents } from "./api.js";
import { debounce, toast } from "./dom.js";

const listeners = new Map();

export function on(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    return () => listeners.get(topic).delete(fn);
}

function emit(...topics) {
    for (const topic of topics) {
        for (const fn of [...(listeners.get(topic) ?? [])]) {
            try {
                fn();
            } catch (error) {
                console.error(`listener for "${topic}" failed`, error);
            }
        }
    }
}

export const state = {
    phase: "boot", // boot | ready | no-project | error
    fatal: null,
    instanceId: null,
    project: null,
    problem: null,
    view: { mode: "list", groupBy: "state", filters: { state: "open", type: "", label: [], assignee: "", milestone: "", search: "", sort: "updated_desc" }, selected: null },
    meta: null,
    items: [],
    total: 0,
    hasNextPage: false,
    endCursor: null,
    loading: false,
    loadingMore: false,
    loadError: null,
    detail: null,
    detailStatus: "idle", // idle | loading | ready | error
    detailError: null,
    live: "connecting", // connecting | live | reconnecting | closed
    saving: 0,
    syncing: false,
};

const MAX_PAGE = 100;
const PAGE = { list: 50, board: MAX_PAGE };
// The most items that are loaded or re-read automatically. Anything beyond it comes from "Load more".
const LOAD_CAP = 500;
const DETAIL_ONLY = ["description", "author", "edited", "lastEditedAt", "lastEditedBy", "tasks", "children", "linked", "blockedByCount", "blockingCount", "locked", "supports", "discussions", "permissions"];

function asView(view) {
    const filters = view?.filters ?? {};
    return {
        mode: view?.mode === "board" ? "board" : "list",
        groupBy: view?.groupBy ?? "state",
        filters: { state: "open", type: "", assignee: "", milestone: "", search: "", sort: "updated_desc", ...filters, label: [...(filters.label ?? [])] },
        selected: Number.isInteger(view?.selected) ? view.selected : null,
    };
}

/** Filters as sent to the server. A board grouped by state has to see both open and closed items. */
export function effectiveFilters() {
    const { filters, mode, groupBy } = state.view;
    return { ...filters, state: mode === "board" && groupBy === "state" ? "all" : filters.state };
}

const fetchKey = () => JSON.stringify([effectiveFilters(), state.view.mode === "board"]);
const toItem = (detail) => Object.fromEntries(Object.entries(detail).filter(([key]) => !DETAIL_ONLY.includes(key)));
const mergeItems = (existing, incoming) => [...new Map([...existing, ...incoming].map((item) => [item.iid, item])).values()];

export const filtersActive = () => {
    const f = state.view.filters;
    return Boolean(f.type || f.label.length || f.assignee || f.milestone || f.search || f.state !== "open");
};

// ---- view persistence -----------------------------------------------------------------------------------------------
let persistChain = Promise.resolve();
function persistView(patch) {
    persistChain = persistChain.then(() => api.setView(patch)).catch(() => {});
}

export function updateView(patch) {
    const before = fetchKey();
    const view = state.view;
    if (patch.mode !== undefined) view.mode = patch.mode;
    if (patch.groupBy !== undefined) view.groupBy = patch.groupBy;
    if (patch.filters) view.filters = { ...view.filters, ...patch.filters };
    persistView(patch);
    emit("view");
    if (fetchKey() !== before) loadItems();
    else emit("items");
}

export function resetFilters() {
    updateView({ filters: { state: "open", type: "", label: [], assignee: "", milestone: "", search: "" } });
}

// ---- boot -----------------------------------------------------------------------------------------------------------
function fail(error) {
    state.phase = "error";
    state.fatal = error instanceof ApiError ? { code: error.code, message: error.message } : { code: "error", message: String(error?.message ?? error) };
    emit("phase");
}

let bootPromise = null;
export function boot() {
    bootPromise ??= (async () => {
        state.phase = "boot";
        state.fatal = null;
        emit("phase");
        try {
            const described = await api.state();
            state.instanceId = described.instanceId;
            state.project = described.project;
            state.problem = described.problem;
            state.view = asView(described.view);
            state.items = [];
            state.total = 0;
            state.hasNextPage = false;
            state.detail = null;
            state.detailStatus = "idle";
            if (!described.configured) {
                state.phase = "no-project";
                emit("phase", "view", "items", "detail");
                return;
            }
            state.meta = await api.meta(true);
            state.phase = "ready";
            emit("phase", "view", "meta", "items", "detail");
            loadItems();
            if (state.view.selected !== null) loadDetail(state.view.selected);
        } catch (error) {
            fail(error);
        } finally {
            bootPromise = null;
        }
    })();
    return bootPromise;
}

export async function switchProject(text) {
    await api.setProject(text);
    await boot();
}

export async function loadMeta(force = false) {
    state.meta = await api.meta(force);
    emit("meta");
    return state.meta;
}

/** Which types may be the parent or a child of `typeName`. A list is null when GitLab did not say, which restricts nothing. */
export function typeRules(typeName) {
    const type = state.meta?.types?.find((t) => t.name === typeName);
    return { parents: type?.parentTypes ?? null, children: type?.childTypes ?? null };
}

/**
 * Scoped labels (`scope::value`) replace each other when the project enforces it. Returns a function that maps a label
 * title to its scope, or null when labels in the same scope may be combined.
 */
export function labelScopeOf() {
    if (!state.meta?.scopedLabels) return null;
    const scopes = new Map((state.meta.labels ?? []).filter((label) => label.scope).map((label) => [label.title, label.scope]));
    return (title) => scopes.get(title) ?? null;
}

// ---- items ----------------------------------------------------------------------------------------------------------
let itemsSeq = 0;
let lastLoadedAt = 0;

export async function loadItems({ quiet = false, more = false } = {}) {
    if (state.phase !== "ready") return;
    if (more && (!state.hasNextPage || state.loadingMore)) return;
    const seq = ++itemsSeq;
    const board = state.view.mode === "board";
    const size = board ? PAGE.board : PAGE.list;
    // A refresh re-reads everything already on screen and publishes it once, so the view never shrinks while it reloads.
    const refresh = quiet && !more;
    const want = board ? LOAD_CAP : refresh ? Math.min(state.items.length, LOAD_CAP) : 0;
    if (more) state.loadingMore = true;
    else {
        state.loadingMore = false;
        state.loading = !quiet;
    }
    state.syncing = true;
    state.loadError = null;
    emit("items");
    const take = (items, page) => {
        state.items = items;
        state.total = page.total;
        state.hasNextPage = page.hasNextPage;
        state.endCursor = page.endCursor;
    };
    try {
        const first = more ? size : refresh ? Math.min(MAX_PAGE, Math.max(size, want)) : size;
        let page = await api.items(effectiveFilters(), { first, after: more ? state.endCursor : undefined });
        if (seq !== itemsSeq) return;
        let items = more ? mergeItems(state.items, page.items) : page.items;
        lastLoadedAt = Date.now();
        if (!refresh) take(items, page);
        while (page.hasNextPage && items.length < want) {
            if (!refresh) emit("items");
            page = await api.items(effectiveFilters(), { first: Math.min(MAX_PAGE, want - items.length), after: page.endCursor });
            if (seq !== itemsSeq) return;
            items = mergeItems(items, page.items);
            if (!refresh) take(items, page);
        }
        if (refresh) take(items, page);
    } catch (error) {
        if (seq === itemsSeq) state.loadError = error;
    } finally {
        if (seq === itemsSeq) {
            state.loading = false;
            state.loadingMore = false;
            state.syncing = false;
            emit("items");
        }
    }
}

export function refreshAll({ meta = false, quiet = true } = {}) {
    if (state.phase !== "ready") return;
    if (meta) loadMeta(true).catch(() => {});
    loadItems({ quiet });
    if (state.view.selected !== null) loadDetail(state.view.selected, { quiet: true });
}

let metaStale = false;
const runScheduledRefresh = debounce(() => {
    const meta = metaStale;
    metaStale = false;
    refreshAll({ meta });
}, 450);
// `meta` is sticky across coalesced calls so a later plain refresh cannot swallow an earlier request to reload labels/members.
const scheduleRefresh = ({ meta = false } = {}) => {
    metaStale ||= meta;
    runScheduledRefresh();
};

// ---- selection and detail -------------------------------------------------------------------------------------------
let detailSeq = 0;

export async function loadDetail(iid, { quiet = false } = {}) {
    const seq = ++detailSeq;
    const same = state.detail?.iid === iid;
    if (!quiet || !same) {
        if (!same) state.detail = null;
        state.detailStatus = "loading";
        state.detailError = null;
        emit("detail");
    }
    try {
        const detail = await api.item(iid);
        if (seq !== detailSeq) return;
        state.detail = detail;
        state.detailStatus = "ready";
        state.detailError = null;
        const index = state.items.findIndex((item) => item.iid === iid);
        if (index >= 0) state.items[index] = toItem(detail);
        emit("items");
    } catch (error) {
        if (seq !== detailSeq) return;
        if (quiet && same) return;
        state.detailStatus = "error";
        state.detailError = error;
    } finally {
        if (seq === detailSeq) emit("detail");
    }
}

function showSelection(next) {
    state.view.selected = next;
    detailSeq++;
    if (next === null) {
        state.detail = null;
        state.detailStatus = "idle";
        state.detailError = null;
    } else {
        if (state.detail?.iid !== next) state.detail = null;
        loadDetail(next);
    }
    emit("view", "detail");
}

export function select(iid, { persist = true } = {}) {
    const next = iid === null || iid === undefined ? null : Number(iid);
    if (next !== null && next === state.view.selected && state.detailStatus !== "error") return;
    showSelection(next);
    if (persist) persistView({ selected: next });
}

// ---- mutations ------------------------------------------------------------------------------------------------------
function absorb(detail) {
    const item = toItem(detail);
    const index = state.items.findIndex((candidate) => candidate.iid === item.iid);
    if (index >= 0) {
        const wanted = effectiveFilters().state;
        if (wanted !== "all" && wanted !== item.state) {
            state.items.splice(index, 1);
            state.total = Math.max(0, state.total - 1);
        } else state.items[index] = item;
    }
    if (state.detail?.iid === detail.iid) {
        state.detail = detail;
        state.detailStatus = "ready";
    }
    emit("items", "detail");
}

function applyLocally(item, patch) {
    const meta = state.meta;
    const next = { ...item };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.state !== undefined) next.state = /^clos/i.test(patch.state) ? "closed" : "open";
    if (patch.assignees !== undefined) {
        const known = (name) => meta.members.find((u) => u.username === name) ?? (meta.user?.username === name ? meta.user : null);
        next.assignees = patch.assignees.map(known).filter(Boolean);
    }
    if (patch.addLabels || patch.removeLabels) {
        let labels = item.labels.filter((label) => !(patch.removeLabels ?? []).includes(label.title));
        for (const title of patch.addLabels ?? []) {
            const label = meta.labels.find((candidate) => candidate.title === title);
            if (label && !labels.some((existing) => existing.title === title)) labels = [...labels, label];
        }
        next.labels = labels;
    }
    if (patch.milestone !== undefined) next.milestone = patch.milestone ? (meta.milestones.find((m) => m.title === patch.milestone) ?? item.milestone) : null;
    return next;
}

async function saving(work) {
    state.saving++;
    emit("status");
    try {
        return await work();
    } finally {
        state.saving--;
        emit("status");
    }
}

/** Updates a work item. With `optimistic`, the list/board shows the change right away and rolls back on failure. */
export async function patchItem(iid, patch, { optimistic = false } = {}) {
    const index = state.items.findIndex((item) => item.iid === iid);
    const before = index >= 0 ? state.items[index] : null;
    if (optimistic && before) {
        state.items[index] = applyLocally(before, patch);
        emit("items");
    }
    try {
        const updated = await saving(() => api.update(iid, patch));
        absorb(updated);
        scheduleRefresh();
        return updated;
    } catch (error) {
        if (optimistic && before) {
            const current = state.items.findIndex((item) => item.iid === iid);
            if (current >= 0) state.items[current] = before;
            emit("items");
        }
        throw error;
    }
}

export async function createItem(data) {
    const created = await saving(() => api.create(data));
    state.detail = created;
    state.detailStatus = "ready";
    scheduleRefresh();
    select(created.iid);
    return created;
}

export async function addChild(parentIid, title) {
    const created = await saving(() => api.create({ title, type: "Task", parent: parentIid }));
    scheduleRefresh();
    loadDetail(parentIid, { quiet: true });
    return created;
}

export async function addComment(iid, body) {
    const note = await saving(() => api.comment(iid, body));
    await loadDetail(iid, { quiet: true });
    scheduleRefresh();
    return note;
}

export async function linkItems(iid, target, type) {
    const updated = await saving(() => api.link(iid, target, type));
    absorb(updated);
    scheduleRefresh();
    return updated;
}

export async function unlinkItems(iid, target) {
    const updated = await saving(() => api.unlink(iid, target));
    absorb(updated);
    scheduleRefresh();
    return updated;
}

// ---- live updates ---------------------------------------------------------------------------------------------------
let helloSeen = false;

function handleEvent(type, data) {
    if (type === "hello") {
        state.instanceId = data?.instanceId ?? state.instanceId;
        if (helloSeen) refreshAll({ meta: true });
        helloSeen = true;
    } else if (type === "changed") {
        scheduleRefresh({ meta: data?.meta === true });
    } else if (type === "view" && data?.view) {
        const before = fetchKey();
        const selected = state.view.selected;
        state.view = asView(data.view);
        emit("view");
        if (fetchKey() !== before) loadItems();
        else emit("items");
        if (state.view.selected !== selected) showSelection(state.view.selected);
    } else if (type === "project") {
        const next = data?.project;
        const same = next && state.project && next.host === state.project.host && next.path === state.project.path;
        if (!(same && state.phase === "ready")) boot();
    }
}

export function startLive() {
    connectEvents(handleEvent, (status) => {
        state.live = status;
        emit("status");
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastLoadedAt > 20_000) refreshAll();
    });
}

export const notifyError = (error) => toast(error?.message ?? String(error), "error", 7000);

// In-memory stand-in for the GitLab service (same method names and normalized shapes as createService in gitlab.mjs).
import { GitLabError, SORTS, normalizeLabel } from "../../canvas/gitlab.mjs";

const HOST = "gitlab.com";
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;
const clone = (v) => structuredClone(v);
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);

export const config = { avatarBase: "" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const TYPES = [
    { id: "gid://gitlab/WorkItems::Type/1", name: "Issue", iconName: "issue-type-issue", childTypes: ["Task"], parentTypes: [] },
    { id: "gid://gitlab/WorkItems::Type/5", name: "Task", iconName: "issue-type-task", childTypes: [], parentTypes: ["Issue", "Incident", "Ticket"] },
    { id: "gid://gitlab/WorkItems::Type/2", name: "Incident", iconName: "issue-type-incident", childTypes: ["Task"], parentTypes: [] },
    { id: "gid://gitlab/WorkItems::Type/8", name: "Ticket", iconName: "issue-type-ticket", childTypes: ["Task"], parentTypes: [] },
];

const LABEL_SPECS = [
    ["bug", "#d9534f", "#ffffff", "Something is broken"],
    ["frontend", "#428bca", "#ffffff", ""],
    ["backend", "#5cb85c", "#ffffff", ""],
    ["docs", "#f0ad4e", "#333333", "Documentation"],
    ["workflow::backlog", "#e5e7eb", "#1f2937", ""],
    ["workflow::in-progress", "#fde68a", "#1f2937", ""],
    ["workflow::review", "#a78bfa", "#ffffff", ""],
    ["workflow::done", "#34d399", "#064e3b", ""],
    ["priority::1", "#dc2626", "#ffffff", ""],
    ["priority::2", "#f59e0b", "#000000", ""],
    ["priority::3", "#10b981", "#000000", ""],
    ["<img src=x onerror=alert(1)>", "#123", "#fff", "hostile label"],
    ["A very long label name that should be truncated somewhere sensible in the UI", "#7c3aed", "#ffffff", ""],
];

const DESCRIPTION_1 = `## Goal

Reward players for **milestones**: "100 clicks", "first upgrade" and _hidden_ ones.

### Acceptance criteria

- [x] Define achievement schema
- [ ] Toast when an achievement unlocks
- [ ] Persist unlocked achievements (see #8)
- [ ] Leaderboard hook (#2)

1. First ordered step
2. Second ordered step
   - nested bullet

> A note quoted from the design review.

\`\`\`js
function unlock(id) {
  return storage.set(\`ach:\${id}\`, Date.now());
}
\`\`\`

Inline \`code\`, a [link](https://example.com/design) and an autolink https://example.com/docs.

| Name | Points |
| --- | --- |
| First click | 1 |
| Hundred | 10 |

---

Hostile bits: <script>window.__pwned = 1</script> [bad](javascript:window.__pwned=2) ![img](data:image/png;base64,AAAA) <img src=x onerror="window.__pwned=3"> [data](data:text/html,<b>x</b>)`;

function usersFor(base) {
    const avatar = (name) => (base ? `${base}/avatar/${name}.svg` : null);
    const make = (n, username, name, av) => ({ id: `gid://gitlab/User/${n}`, username, name, avatarUrl: av ?? null, webUrl: `https://${HOST}/${username}` });
    return [
        make(1, "feured", "Fabien Feured", avatar("feured")),
        make(2, "alice", "Alice Martin", avatar("alice")),
        make(3, "bob", "Bob Lee", null),
        make(4, "carol", "carol", null),
        make(5, "mallory", '"><svg onload=window.__pwned=4>', null),
    ];
}

function seedMain(store) {
    const rec = (iid, o) =>
        store.recs.set(iid, {
            iid,
            title: "",
            state: "open",
            type: "Issue",
            labels: [],
            assignees: [],
            milestone: null,
            startDate: null,
            dueDate: null,
            parent: null,
            confidential: false,
            description: "",
            author: "feured",
            createdAt: ago(20 * DAY),
            updatedAt: ago(DAY),
            closedAt: null,
            notes: [],
            ...o,
        });
    const note = (n, author, body, msAgo, internal = false) => ({ id: `gid://gitlab/Note/${n}`, body, author, createdAt: ago(msAgo), updatedAt: ago(msAgo), internal });

    rec(1, { title: "Add clicker achievements and milestones", labels: ["workflow::in-progress", "frontend", "priority::2"], assignees: ["feured"], milestone: "v1.0", dueDate: ymd(9), startDate: ymd(-5), description: DESCRIPTION_1, updatedAt: ago(3 * HOUR), notes: [note(1, "alice", "Looks good! **Ship it** after the review. Related: #3", 2 * DAY), note(2, "bob", "Internal: waiting on legal wording for the badge text.", 30 * HOUR, true), note(3, "feured", "Added the schema in `achievements.py`.", 3 * HOUR)] });
    rec(2, { title: "Add a persistent clicker leaderboard", labels: ["workflow::backlog", "backend"], description: "Store scores per player and show the top 10.", createdAt: ago(18 * DAY), updatedAt: ago(5 * DAY) });
    rec(3, { title: "Add clicker upgrades and auto-clickers", labels: ["workflow::review", "priority::1", "bug"], assignees: ["feured", "alice"], milestone: "v1.0", dueDate: ymd(-3), description: "Auto-clickers produce 1 click/s per level.\n\nSee also #1.", updatedAt: ago(40 * MIN), notes: [note(4, "alice", "Ready for review.", 50 * MIN)] });
    rec(4, { title: "Crash on save when the username contains emoji 🎮", type: "Incident", labels: ["bug", "priority::1", "workflow::in-progress"], assignees: ["bob"], dueDate: ymd(2), description: "Stack trace:\n\n```\nUnicodeEncodeError: 'latin-1' codec can't encode character\n```", updatedAt: ago(10 * MIN) });
    rec(5, { title: "Write docs for the REST API", labels: ["docs", "workflow::done"], state: "closed", closedAt: ago(2 * DAY), assignees: ["carol"], milestone: "v1.1", description: "Done.", updatedAt: ago(2 * DAY) });
    rec(6, { title: "Investigate intermittent websocket disconnects on Safari when the tab is backgrounded for more than five minutes and the user returns to the clicker page", labels: ["bug", "frontend", "backend", "A very long label name that should be truncated somewhere sensible in the UI"], assignees: ["bob", "carol", "alice", "feured"], description: "x".repeat(300), updatedAt: ago(6 * DAY) });
    rec(7, { title: "Design achievement badges", type: "Task", parent: 1, labels: ["frontend"], assignees: ["alice"], description: "Three tiers: bronze, silver, gold.", updatedAt: ago(DAY) });
    rec(8, { title: "Persist unlocked achievements", type: "Task", parent: 1, state: "closed", closedAt: ago(DAY), labels: ["backend"], assignees: ["feured"], updatedAt: ago(DAY) });
    rec(9, { title: "Customer asks for a dark mode", type: "Ticket", labels: ["frontend"], confidential: true, description: "Reported by a customer.", updatedAt: ago(9 * DAY) });
    rec(10, { title: "Label overflow", labels: ["bug", "frontend", "backend", "docs", "workflow::backlog", "priority::1", "priority::2", "priority::3", "<img src=x onerror=alert(1)>"], description: "", updatedAt: ago(11 * DAY) });
    rec(11, { title: '<script>window.__pwned=5</script> "quotes" & <b>bold</b>', labels: [], assignees: ["mallory"], description: "", updatedAt: ago(12 * DAY) });
    rec(12, { title: "Unassigned, unlabeled, no milestone", description: "", updatedAt: ago(13 * DAY) });
    rec(13, { title: "Already done and shipped", state: "closed", closedAt: ago(30 * DAY), labels: ["workflow::done"], milestone: "v1.0", updatedAt: ago(30 * DAY) });
    store.links.push({ id: 1, kind: "blocks", a: 2, b: 3 }, { id: 2, kind: "related", a: 1, b: 4 });
}

function seedPaging(store, count = 130) {
    const pool = ["bug", "frontend", "backend", "docs"];
    for (let i = 1; i <= count; i++) {
        store.recs.set(i, { iid: i, title: `Filler item ${i}`, state: i % 5 === 0 ? "closed" : "open", type: "Issue", labels: [pool[i % pool.length], ...(i % 3 === 0 ? ["workflow::backlog"] : [])], assignees: i % 2 ? ["alice"] : [], milestone: null, startDate: null, dueDate: null, parent: null, confidential: false, description: "", author: "feured", createdAt: ago(i * HOUR), updatedAt: ago(i * HOUR), closedAt: null, notes: [] });
    }
}

const SEEDS = { "acme/flask-demo": seedMain, "acme/paging": seedPaging, "acme/huge": (s) => seedPaging(s, 700), "acme/empty": () => {}, "acme/other": (s) => { s.noRules = true; s.recs.set(1, { iid: 1, title: "Only item in the other project", state: "open", type: "Issue", labels: [], assignees: [], milestone: null, startDate: null, dueDate: null, parent: null, confidential: false, description: "", author: "feured", createdAt: ago(DAY), updatedAt: ago(DAY), closedAt: null, notes: [] }); } };

const stores = new Map();

export function getStore(path) {
    const key = path.toLowerCase();
    let store = stores.get(key);
    if (store) return store;
    if (!SEEDS[key]) return null;
    store = { path: key, recs: new Map(), links: [], users: usersFor(config.avatarBase), labels: LABEL_SPECS.map(([title, color, textColor, description], i) => normalizeLabel({ id: `gid://gitlab/ProjectLabel/${i + 1}`, title, color, textColor, description })), milestones: [{ id: "gid://gitlab/Milestone/1", title: "v1.0", state: "active", dueDate: ymd(14), startDate: ymd(-30) }, { id: "gid://gitlab/Milestone/2", title: "v1.1", state: "active", dueDate: ymd(60), startDate: ymd(15) }, { id: "gid://gitlab/Milestone/3", title: "Backlog", state: "active", dueDate: null, startDate: null }], latency: 12, failNext: null, calls: [], nextIid: 0, nextNote: 100, nextLink: 100 };
    if (key === "acme/empty") {
        store.labels = [];
        store.milestones = [];
        store.users = store.users.slice(0, 1);
    }
    SEEDS[key](store);
    store.nextIid = Math.max(0, ...store.recs.keys()) + 1;
    stores.set(key, store);
    return store;
}

export const resetStores = () => stores.clear();

const gid = (iid) => `gid://gitlab/WorkItem/${1000 + iid}`;
const typeOf = (store, name) => TYPES.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
const userOf = (store, username) => store.users.find((u) => u.username === username);
const mini = (store, r) => r && { id: gid(r.iid), iid: r.iid, title: r.title, state: r.state, webUrl: webUrl(store, r.iid), type: typeOf(store, r.type).name, iconName: typeOf(store, r.type).iconName };
const webUrl = (store, iid) => `https://${HOST}/${store.path}/-/work_items/${iid}`;

function linksOf(store, iid) {
    const out = [];
    for (const l of store.links) {
        if (l.kind === "related" && (l.a === iid || l.b === iid)) out.push({ linkId: `gid://gitlab/Link/${l.id}`, type: "related", other: l.a === iid ? l.b : l.a });
        else if (l.kind === "blocks" && l.a === iid) out.push({ linkId: `gid://gitlab/Link/${l.id}`, type: "blocks", other: l.b });
        else if (l.kind === "blocks" && l.b === iid) out.push({ linkId: `gid://gitlab/Link/${l.id}`, type: "blocked_by", other: l.a });
    }
    return out;
}

function toItem(store, r) {
    const t = typeOf(store, r.type);
    const links = linksOf(store, r.iid);
    const parent = r.parent ? store.recs.get(r.parent) : null;
    return {
        id: gid(r.iid),
        iid: r.iid,
        title: r.title,
        state: r.state,
        confidential: r.confidential,
        webUrl: webUrl(store, r.iid),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        closedAt: r.closedAt,
        comments: r.notes.filter((n) => !n.internal).length + r.notes.filter((n) => n.internal).length,
        type: { id: t.id, name: t.name, iconName: t.iconName },
        labels: r.labels.map((l) => store.labels.find((x) => x.title === l)).filter(Boolean),
        assignees: r.assignees.map((u) => userOf(store, u)).filter(Boolean),
        milestone: store.milestones.find((m) => m.title === r.milestone) ?? null,
        startDate: r.startDate,
        dueDate: r.dueDate,
        parent: parent ? mini(store, parent) : null,
        hasChildren: [...store.recs.values()].some((c) => c.parent === r.iid),
        blocked: links.some((l) => l.type === "blocked_by" && store.recs.get(l.other)?.state === "open"),
    };
}

function toDetail(store, r) {
    const base = toItem(store, r);
    const boxes = [...r.description.matchAll(/^\s*[-*]\s+\[([ xX])\]/gm)];
    const links = linksOf(store, r.iid).map((l) => ({ linkId: l.linkId, type: l.type, item: mini(store, store.recs.get(l.other)) })).filter((l) => l.item);
    const incident = r.type === "Incident";
    return {
        ...base,
        description: r.description,
        author: userOf(store, r.author) ?? null,
        edited: false,
        lastEditedAt: null,
        lastEditedBy: null,
        tasks: boxes.length ? { total: boxes.length, done: boxes.filter((m) => m[1] !== " ").length } : null,
        children: [...store.recs.values()].filter((c) => c.parent === r.iid).map((c) => mini(store, c)),
        linked: links,
        blockedByCount: links.filter((l) => l.type === "blocked_by").length,
        blockingCount: links.filter((l) => l.type === "blocks").length,
        locked: false,
        supports: { labels: true, assignees: true, milestone: true, dates: true, hierarchy: !incident, links: true, notes: true },
        discussions: r.notes.map((n) => ({ id: `gid://gitlab/Discussion/${n.id.split("/").pop()}`, notes: [{ id: n.id, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt, internal: n.internal, author: userOf(store, n.author) ?? null }] })),
        permissions: { update: true, comment: true, link: true, setParent: true },
    };
}

function matches(store, r, f) {
    const state = f.state ?? "open";
    if (state !== "all" && r.state !== state) return false;
    const wantedTypes = asList(f.type).map((t) => t.toLowerCase());
    if (wantedTypes.length && !wantedTypes.includes(r.type.toLowerCase())) return false;
    if (!asList(f.label).every((l) => r.labels.some((x) => x.toLowerCase() === l.toLowerCase()))) return false;
    const assignee = String(f.assignee ?? "").replace(/^@/, "").toLowerCase();
    if (assignee) {
        if (assignee === "none") { if (r.assignees.length) return false; }
        else if (assignee === "any") { if (!r.assignees.length) return false; }
        else if (assignee === "me") { if (!r.assignees.includes("feured")) return false; }
        else if (!r.assignees.some((u) => u.toLowerCase() === assignee)) return false;
    }
    const ms = String(f.milestone ?? "").toLowerCase();
    if (ms) {
        if (ms === "none") { if (r.milestone) return false; }
        else if (ms === "any") { if (!r.milestone) return false; }
        else if (ms === "started" || ms === "upcoming") { if (!r.milestone) return false; }
        else if ((r.milestone ?? "").toLowerCase() !== ms) return false;
    }
    const search = String(f.search ?? "").trim();
    if (search) {
        if (/^#\d+$/.test(search)) { if (r.iid !== Number(search.slice(1))) return false; }
        else if (!`${r.title}\n${r.description}`.toLowerCase().includes(search.toLowerCase())) return false;
    }
    return true;
}

const SORT_FNS = {
    updated_desc: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    updated_asc: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    created_desc: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.iid - a.iid,
    created_asc: (a, b) => a.createdAt.localeCompare(b.createdAt) || a.iid - b.iid,
    title_asc: (a, b) => a.title.localeCompare(b.title),
    title_desc: (a, b) => b.title.localeCompare(a.title),
    due_asc: (a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
    due_desc: (a, b) => (b.dueDate ?? "0000").localeCompare(a.dueDate ?? "0000"),
};

const invalid = (message) => new GitLabError("invalid", message);
const missing = (store, iid) => new GitLabError("not_found", `Work item #${iid} does not exist in ${store.path}.`);

function checkDate(value, field) {
    if (value === undefined || value === null || value === "") return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw invalid(`${field} must be a date like 2025-01-31.`);
    return String(value);
}

function checkNames(store, kind, names, exists) {
    const unknown = asList(names).filter((n) => !exists(String(n).replace(/^@/, "")));
    if (unknown.length) throw invalid(`Unknown ${kind}: ${unknown.join(", ")}.`);
}

export function makeMockService({ host, projectPath }) {
    const key = projectPath.toLowerCase();
    const getStoreOrThrow = () => {
        const store = getStore(key);
        if (!store) throw new GitLabError("not_found", `Project "${projectPath}" was not found on ${host}, or your glab account cannot access it.`);
        return store;
    };

    async function gate(method, args, { mutation = false } = {}) {
        const store = getStoreOrThrow();
        store.calls.push({ method, args: clone(args) });
        if (store.latency) await sleep(store.latency);
        if (store.failNext && (mutation || store.failNext.reads) && (!store.failNext.method || store.failNext.method === method)) {
            const { code, message } = store.failNext;
            store.failNext = null;
            throw new GitLabError(code, message);
        }
        return store;
    }

    const touch = (r) => {
        r.updatedAt = new Date().toISOString();
    };

    function applyWritable(store, r, p, { creating = false } = {}) {
        if (p.title !== undefined || creating) {
            const title = String(p.title ?? "").trim();
            if (!title) throw invalid("A title is required.");
            if (title.length > 255) throw invalid("The title is too long (max 255 characters).");
            if (title.includes("FAIL ME")) throw new GitLabError("mutation_failed", "Title is not allowed (mock failure).");
            r.title = title;
        }
        if (p.description !== undefined) r.description = String(p.description);
        if (p.confidential !== undefined) r.confidential = Boolean(p.confidential);
        if (p.assignees !== undefined) {
            checkNames(store, "user", p.assignees, (n) => store.users.some((u) => u.username.toLowerCase() === n.toLowerCase()));
            r.assignees = asList(p.assignees).map((n) => store.users.find((u) => u.username.toLowerCase() === String(n).replace(/^@/, "").toLowerCase()).username);
        }
        const add = asList(p.addLabels ?? (creating ? p.labels : undefined));
        const remove = asList(p.removeLabels);
        checkNames(store, "label", [...add, ...remove], (n) => store.labels.some((l) => l.title.toLowerCase() === n.toLowerCase()));
        for (const n of add) {
            const title = store.labels.find((l) => l.title.toLowerCase() === n.toLowerCase()).title;
            if (!r.labels.includes(title)) r.labels.push(title);
        }
        r.labels = r.labels.filter((l) => !remove.some((n) => n.toLowerCase() === l.toLowerCase()));
        if (p.milestone !== undefined) {
            if (p.milestone === "" || p.milestone === null) r.milestone = null;
            else {
                const m = store.milestones.find((x) => x.title.toLowerCase() === String(p.milestone).toLowerCase());
                if (!m) throw invalid(`Unknown milestone: ${p.milestone}.`);
                r.milestone = m.title;
            }
        }
        if (p.startDate !== undefined) r.startDate = checkDate(p.startDate, "startDate");
        if (p.dueDate !== undefined) r.dueDate = checkDate(p.dueDate, "dueDate");
        if (p.parent !== undefined) {
            if (p.parent === "" || p.parent === null) r.parent = null;
            else {
                const iid = Number(p.parent);
                const parent = store.recs.get(iid);
                if (!parent) throw missing(store, iid);
                if (iid === r.iid) throw invalid("A work item cannot be its own parent.");
                if (parent.type === "Task") throw new GitLabError("mutation_failed", "A Task cannot have child items.");
                if (r.type !== "Task") throw new GitLabError("mutation_failed", `A ${r.type} cannot be a child of a ${parent.type}.`);
                r.parent = iid;
            }
        }
    }

    return {
        host,
        projectPath,
        async meta() {
            const store = await gate("meta", {});
            const ruled = !store.noRules;
            const types = TYPES.map((t) => ({ ...t, childTypes: ruled ? t.childTypes : null, parentTypes: ruled ? t.parentTypes : null }));
            return clone({ project: { id: "gid://gitlab/Project/1", name: store.path.split("/").pop(), fullPath: store.path, webUrl: `https://${HOST}/${store.path}` }, host, user: store.users[0], types, scopedLabels: ruled ? store.scopedLabels ?? true : null, labels: store.labels, scopes: [...new Set(store.labels.map((l) => l.scope).filter(Boolean))].sort(), members: store.users, milestones: store.milestones, truncated: false });
        },
        async list(filter = {}, { first = 50, after } = {}) {
            const store = await gate("list", { filter, first, after });
            if (!(String(filter.sort ?? "updated_desc") in SORTS)) throw invalid(`Unknown sort "${filter.sort}".`);
            const size = Math.min(Math.max(Number(first) || 50, 1), 100);
            const all = [...store.recs.values()].filter((r) => matches(store, r, filter)).sort(SORT_FNS[filter.sort ?? "updated_desc"] ?? SORT_FNS.updated_desc);
            const start = Number(after) || 0;
            const slice = all.slice(start, start + size);
            const end = start + slice.length;
            return clone({ items: slice.map((r) => toItem(store, r)), total: all.length, hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null });
        },
        async get(iid) {
            const store = await gate("get", { iid });
            const r = store.recs.get(Number(iid));
            if (!r) throw missing(store, iid);
            return clone(toDetail(store, r));
        },
        async create(input = {}) {
            const store = await gate("create", input, { mutation: true });
            const type = typeOf(store, input.type || "Issue");
            if (!type) throw invalid(`Unknown work item type "${input.type}". Available: ${TYPES.map((t) => t.name).join(", ")}.`);
            const r = { iid: store.nextIid, title: "", state: "open", type: type.name, labels: [], assignees: [], milestone: null, startDate: null, dueDate: null, parent: null, confidential: false, description: "", author: "feured", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), closedAt: null, notes: [] };
            applyWritable(store, r, input, { creating: true });
            store.recs.set(r.iid, r);
            store.nextIid += 1;
            return clone(toDetail(store, r));
        },
        async update(iid, patch = {}) {
            const store = await gate("update", { iid, patch }, { mutation: true });
            const r = store.recs.get(Number(iid));
            if (!r) throw missing(store, iid);
            if (patch.state !== undefined) {
                if (!["open", "closed"].includes(patch.state)) throw invalid('state must be "open" or "closed".');
                r.state = patch.state;
                r.closedAt = patch.state === "closed" ? new Date().toISOString() : null;
            }
            applyWritable(store, r, patch);
            touch(r);
            return clone(toDetail(store, r));
        },
        async comment(iid, body) {
            const store = await gate("comment", { iid, body }, { mutation: true });
            const r = store.recs.get(Number(iid));
            if (!r) throw missing(store, iid);
            if (!String(body ?? "").trim()) throw invalid("The comment is empty.");
            const n = { id: `gid://gitlab/Note/${store.nextNote++}`, body: String(body), author: "feured", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), internal: false };
            r.notes.push(n);
            touch(r);
            return clone({ ...n, author: userOf(store, "feured") });
        },
        async link(iid, target, type = "related") {
            const store = await gate("link", { iid, target, type }, { mutation: true });
            const a = Number(iid);
            const b = Number(target);
            if (!store.recs.get(a)) throw missing(store, a);
            if (!store.recs.get(b)) throw missing(store, b);
            if (a === b) throw invalid("A work item cannot be linked to itself.");
            if (store.links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) throw new GitLabError("mutation_failed", "These work items are already linked.");
            if (!["related", "blocks", "blocked_by"].includes(type)) throw invalid(`Unknown link type "${type}".`);
            store.links.push(type === "related" ? { id: store.nextLink++, kind: "related", a, b } : type === "blocks" ? { id: store.nextLink++, kind: "blocks", a, b } : { id: store.nextLink++, kind: "blocks", a: b, b: a });
            return clone(toDetail(store, store.recs.get(a)));
        },
        async unlink(iid, target) {
            const store = await gate("unlink", { iid, target }, { mutation: true });
            const a = Number(iid);
            const b = Number(target);
            const before = store.links.length;
            store.links = store.links.filter((l) => !((l.a === a && l.b === b) || (l.a === b && l.b === a)));
            if (store.links.length === before) throw new GitLabError("not_found", `#${a} is not linked to #${b}.`);
            return clone(toDetail(store, store.recs.get(a)));
        },
    };
}

export function mockDetect(cwd) {
    const dir = String(cwd ?? "");
    if (dir.includes("no-remote")) return Promise.resolve(null);
    if (dir.includes("other")) return Promise.resolve({ host: HOST, path: "acme/other" });
    return Promise.resolve({ host: HOST, path: "acme/flask-demo" });
}

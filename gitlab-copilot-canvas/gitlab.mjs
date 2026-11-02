// GitLab work-items data layer.
//
// Every GitLab call goes through the user's own `glab` CLI (`glab api graphql`), so this extension never
// sees or stores a token: hosts, credentials and proxies are whatever `glab auth login` configured.
import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export class GitLabError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = "GitLabError";
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

const GLAB_HELP =
    "The GitLab CLI (`glab`) was not found. Install it (macOS: `brew install glab`) and run `glab auth login`, " +
    "or set GLAB_PATH to the executable.";
const META_TTL_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_PARALLEL_CALLS = 4;

// ---------------------------------------------------------------------------------------------
// Process runners
// ---------------------------------------------------------------------------------------------

let glabLookup = null;

async function resolveGlab() {
    if (process.env.GLAB_PATH) return process.env.GLAB_PATH;
    glabLookup ??= (async () => {
        const exe = process.platform === "win32" ? "glab.exe" : "glab";
        const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
        // GUI apps often start with a minimal PATH that lacks Homebrew, so probe the usual locations too.
        const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin", path.join(homedir(), ".local", "bin")];
        for (const dir of [...dirs, ...extra]) {
            const candidate = path.join(dir, exe);
            try {
                await access(candidate, constants.X_OK);
                return candidate;
            } catch {
                /* keep looking */
            }
        }
        return null;
    })();
    const found = await glabLookup;
    if (!found) glabLookup = null;
    return found;
}

let busy = 0;
const waiting = [];
async function acquireSlot() {
    if (busy < MAX_PARALLEL_CALLS) {
        busy++;
        return;
    }
    await new Promise((resolve) => waiting.push(resolve));
}
function releaseSlot() {
    const next = waiting.shift();
    if (next) next();
    else busy--;
}

/** Runs `glab` with the given arguments. Resolves with the exit code and output; rejects only on spawn problems. */
export async function runGlab(args, { stdin = "", timeoutMs = 45_000 } = {}) {
    const bin = await resolveGlab();
    if (!bin) throw new GitLabError("glab_missing", GLAB_HELP);
    await acquireSlot();
    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(bin, args, {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, NO_COLOR: "1", GLAB_NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false" },
                windowsHide: true,
            });
            const out = [];
            const err = [];
            let size = 0;
            let settled = false;
            let timer;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            };
            timer = setTimeout(() => {
                child.kill("SIGKILL");
                finish(reject, new GitLabError("timeout", `glab did not answer within ${Math.round(timeoutMs / 1000)}s.`));
            }, timeoutMs);
            child.on("error", (e) =>
                finish(reject, e.code === "ENOENT" ? new GitLabError("glab_missing", GLAB_HELP) : new GitLabError("glab_failed", e.message)),
            );
            child.stdout.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_OUTPUT_BYTES) {
                    child.kill("SIGKILL");
                    finish(reject, new GitLabError("too_large", "GitLab returned more data than the canvas can handle."));
                } else out.push(chunk);
            });
            child.stderr.on("data", (chunk) => {
                if (err.length < 64) err.push(chunk);
            });
            child.on("close", (code) =>
                finish(resolve, { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
            );
            child.stdin.on("error", () => {});
            child.stdin.end(stdin);
        });
    } finally {
        releaseSlot();
    }
}

function runGit(args) {
    return new Promise((resolve, reject) => {
        execFile("git", args, { timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
        );
    });
}

function classifyFailure(code, stderr, stdout) {
    const message = (stderr || stdout || `glab exited with code ${code}`).trim().split("\n").slice(-3).join(" ").slice(0, 400);
    if (/\b401\b|unauthori[sz]ed|not logged in|no token|not authenticated|glab auth login/i.test(message)) {
        return new GitLabError("auth", `glab is not authenticated for this GitLab host. Run \`glab auth login\`. (${message})`);
    }
    if (/\b404\b|not found/i.test(message)) return new GitLabError("not_found", message);
    if (/\b403\b|forbidden|insufficient_scope/i.test(message)) return new GitLabError("forbidden", message);
    if (/\b400\b|\b422\b|unprocessable|validation failed/i.test(message)) return new GitLabError("invalid", message);
    if (/could not resolve|no such host|dial tcp|i\/o timeout|connection (refused|reset)|network is unreachable|ENOTFOUND|ECONNREFUSED/i.test(message)) {
        return new GitLabError("network", `Could not reach GitLab: ${message}`);
    }
    return new GitLabError("glab_failed", message);
}

async function graphql(host, query, variables, run) {
    const { code, stdout, stderr } = await run(["api", "graphql", "--hostname", host, "--input", "-"], {
        stdin: JSON.stringify({ query, variables }),
    });
    const text = stdout.trim();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    if (json?.errors?.length) {
        const message = json.errors.map((e) => e.message).join("; ");
        const denied = /not authorized|don't have permission|permission/i.test(message);
        throw new GitLabError(denied ? "forbidden" : "graphql", message, json.errors);
    }
    if (code === 0 && json && typeof json === "object" && "data" in json) return json.data ?? {};
    throw classifyFailure(code, stderr, text);
}

// ---------------------------------------------------------------------------------------------
// Project detection
// ---------------------------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;
const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$/;

/** Parses an https/ssh/scp-style git remote URL into `{ host, path }`. */
export function parseRemoteUrl(raw) {
    const url = String(raw ?? "").trim();
    let host;
    let repoPath;
    let m = url.match(/^https?:\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::(\d+))?\/(.+)$/i);
    if (m) {
        host = m[2] ? `${m[1]}:${m[2]}` : m[1];
        repoPath = m[3];
    } else if ((m = url.match(/^(?:ssh|git):\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?\/(.+)$/i))) {
        host = m[1];
        repoPath = m[2];
    } else if ((m = url.match(/^(?:[^@/\s]+@)?([^/\s:]+):(?!\/)(.+)$/))) {
        host = m[1];
        repoPath = m[2];
    } else {
        return null;
    }
    repoPath = repoPath.split("/-/")[0].replace(/\/+$/, "").replace(/\.git$/i, "");
    return { host: host.toLowerCase(), path: repoPath };
}

/** Turns user input ("group/project", "host/group/project" or a project URL) into `{ host, path }`, or null. */
export function parseProjectRef(text, defaultHost) {
    const value = String(text ?? "").trim();
    if (!value) return null;
    let ref = parseRemoteUrl(value);
    if (!ref) {
        const cleaned = value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
        const segments = cleaned.split("/");
        ref = segments[0].includes(".") && segments.length >= 3 ? { host: segments[0].toLowerCase(), path: segments.slice(1).join("/") } : { host: defaultHost, path: cleaned };
    }
    if (!ref.host || !HOST_RE.test(ref.host) || !PATH_RE.test(ref.path)) return null;
    return ref;
}

/** Finds the GitLab project behind a working directory's git remotes. */
export async function detectProject(cwd, { git = runGit } = {}) {
    if (!cwd) return null;
    let listing;
    try {
        listing = await git(["-C", cwd, "remote", "-v"]);
    } catch {
        return null;
    }
    const remotes = [];
    for (const line of listing.split("\n")) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
        const ref = m && parseRemoteUrl(m[2]);
        const otherProvider = ref && /^(github\.com|[^/]+\.ghe\.com|bitbucket\.org|dev\.azure\.com|ssh\.dev\.azure\.com|[^/]+\.visualstudio\.com)(:\d+)?$/i.test(ref.host);
        if (ref && !otherProvider && HOST_RE.test(ref.host) && PATH_RE.test(ref.path)) remotes.push({ remote: m[1], ...ref });
    }
    const looksLikeGitLab = (r) => /gitlab/i.test(r.host);
    return remotes.find((r) => r.remote === "origin" && looksLikeGitLab(r)) ?? remotes.find(looksLikeGitLab) ?? remotes.find((r) => r.remote === "origin") ?? remotes[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------------------------

const USER_FIELDS = "id username name avatarUrl webUrl";
const LABEL_FIELDS = "id title color textColor description";
const MILESTONE_FIELDS = "id title state dueDate startDate webPath";
const MINI_FIELDS = "id iid title state webUrl workItemType { name iconName }";
const CORE_FIELDS = `id iid title state confidential webUrl createdAt updatedAt closedAt userDiscussionsCount workItemType { id name iconName }`;

const WIDGET = {
    labels: `... on WorkItemWidgetLabels { labels(first: 100) { nodes { ${LABEL_FIELDS} } } }`,
    assignees: `... on WorkItemWidgetAssignees { assignees(first: 20) { nodes { ${USER_FIELDS} } } }`,
    milestone: `... on WorkItemWidgetMilestone { milestone { ${MILESTONE_FIELDS} } }`,
    dates: "... on WorkItemWidgetStartAndDueDate { startDate dueDate }",
    hierarchyList: `... on WorkItemWidgetHierarchy { hasChildren hasParent parent { ${MINI_FIELDS} } }`,
    hierarchyDetail: `... on WorkItemWidgetHierarchy { hasChildren hasParent parent { ${MINI_FIELDS} } children(first: 100) { nodes { ${MINI_FIELDS} } } }`,
    linkedList: "... on WorkItemWidgetLinkedItems { blocked blockedByCount blockingCount }",
    linkedDetail: `... on WorkItemWidgetLinkedItems { blocked blockedByCount blockingCount linkedItems(first: 100) { nodes { linkId linkType workItem { ${MINI_FIELDS} } } } }`,
    description: "... on WorkItemWidgetDescription { edited lastEditedAt lastEditedBy { username name } taskCompletionStatus { count completedCount } }",
    notes: `... on WorkItemWidgetNotes { discussionLocked discussions(first: 100, filter: ONLY_COMMENTS, sort: CREATED_ASC) { nodes { id notes(first: 100) { nodes { id body createdAt updatedAt internal author { ${USER_FIELDS} } } } } } }`,
};

const LIST_ITEM = `${CORE_FIELDS} widgets(onlyTypes: [LABELS, ASSIGNEES, MILESTONE, START_AND_DUE_DATE, HIERARCHY, LINKED_ITEMS]) { type ${WIDGET.labels} ${WIDGET.assignees} ${WIDGET.milestone} ${WIDGET.dates} ${WIDGET.hierarchyList} ${WIDGET.linkedList} }`;
const DETAIL_ITEM = `${CORE_FIELDS} description author { ${USER_FIELDS} } userPermissions { updateWorkItem createNote adminParentLink adminWorkItemLink deleteWorkItem } widgets(onlyTypes: [LABELS, ASSIGNEES, MILESTONE, START_AND_DUE_DATE, HIERARCHY, LINKED_ITEMS, DESCRIPTION, NOTES]) { type ${WIDGET.labels} ${WIDGET.assignees} ${WIDGET.milestone} ${WIDGET.dates} ${WIDGET.hierarchyDetail} ${WIDGET.linkedDetail} ${WIDGET.description} ${WIDGET.notes} }`;

export const DOCS = {
    meta: `query WorkItemsMeta($fullPath: ID!) {
  currentUser { id username name avatarUrl }
  project(fullPath: $fullPath) {
    id name fullPath webUrl
    workItemTypes { nodes { id name iconName } }
    labels(first: 100, includeAncestorGroups: true, searchIn: [TITLE]) { pageInfo { hasNextPage } nodes { ${LABEL_FIELDS} } }
    projectMembers(first: 100, relations: [DIRECT, INHERITED]) { pageInfo { hasNextPage } nodes { user { ${USER_FIELDS} } } }
    milestones(first: 100, state: active, includeAncestors: true) { pageInfo { hasNextPage } nodes { ${MILESTONE_FIELDS} } }
  }
}`,
    // Which types may be parents/children of which, and whether scoped labels are exclusive. Fetched on its own because
    // older GitLab versions lack some of these fields; the canvas then simply stops restricting choices.
    typeRules: `query WorkItemTypeRules($fullPath: ID!) {
  project(fullPath: $fullPath) {
    id
    workItemTypes {
      nodes {
        name
        widgetDefinitions {
          type
          ... on WorkItemWidgetDefinitionHierarchy { allowedChildTypes { nodes { name } } allowedParentTypes { nodes { name } } }
          ... on WorkItemWidgetDefinitionLabels { allowsScopedLabels }
        }
      }
    }
  }
}`,
    list: `query WorkItemsList(
  $fullPath: ID!, $first: Int!, $after: String, $state: IssuableState, $search: String, $in: [IssuableSearchableField!],
  $iids: [String!], $types: [IssueType!], $labelName: [String!], $assigneeUsernames: [String!],
  $assigneeWildcardId: AssigneeWildcardId, $milestoneTitle: [String!], $milestoneWildcardId: MilestoneWildcardId,
  $authorUsername: String, $sort: WorkItemSort
) {
  project(fullPath: $fullPath) {
    id
    workItems(
      first: $first, after: $after, state: $state, search: $search, in: $in, iids: $iids, types: $types, labelName: $labelName,
      assigneeUsernames: $assigneeUsernames, assigneeWildcardId: $assigneeWildcardId, milestoneTitle: $milestoneTitle,
      milestoneWildcardId: $milestoneWildcardId, authorUsername: $authorUsername, sort: $sort
    ) {
      count
      pageInfo { hasNextPage endCursor }
      nodes { ${LIST_ITEM} }
    }
  }
}`,
    detail: `query WorkItemDetail($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    id
    workItems(iids: [$iid], state: all, first: 1) { nodes { ${DETAIL_ITEM} } }
  }
}`,
    idLookup: `query WorkItemId($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    id
    workItems(iids: [$iid], state: all, first: 1) { nodes { id iid } }
  }
}`,
    update: `mutation UpdateWorkItem($input: WorkItemUpdateInput!) {
  workItemUpdate(input: $input) { errors workItem { ${DETAIL_ITEM} } }
}`,
    create: `mutation CreateWorkItem($input: WorkItemCreateInput!) {
  workItemCreate(input: $input) { errors workItem { ${DETAIL_ITEM} } }
}`,
    note: `mutation CreateWorkItemNote($input: CreateNoteInput!) {
  createNote(input: $input) { errors note { id body createdAt updatedAt internal author { ${USER_FIELDS} } } }
}`,
    addLinks: `mutation LinkWorkItems($input: WorkItemAddLinkedItemsInput!) {
  workItemAddLinkedItems(input: $input) { errors message workItem { ${DETAIL_ITEM} } }
}`,
    removeLinks: `mutation UnlinkWorkItems($input: WorkItemRemoveLinkedItemsInput!) {
  workItemRemoveLinkedItems(input: $input) { errors message workItem { ${DETAIL_ITEM} } }
}`,
};

// ---------------------------------------------------------------------------------------------
// Normalisation: GraphQL nodes -> plain JSON the UI and the agent actions share
// ---------------------------------------------------------------------------------------------

const nodesOf = (connection) => (connection?.nodes ?? []).filter(Boolean);
const safeColor = (value, fallback) => (/^#[0-9a-f]{3,8}$/i.test(String(value ?? "")) ? value : fallback);
const widgetsOf = (node) => Object.fromEntries((node?.widgets ?? []).map((w) => [w.type, w]));
const stateOf = (value) => (value === "CLOSED" ? "closed" : "open");

function absoluteUrl(host, value) {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/")) return `https://${host}${value}`;
    return null;
}

function normalizeUser(u, host) {
    return u && { id: u.id ?? null, username: u.username, name: u.name || u.username, avatarUrl: absoluteUrl(host, u.avatarUrl ?? u.avatar_url), webUrl: absoluteUrl(host, u.webUrl ?? u.web_url) };
}

export function normalizeLabel(l) {
    const title = String(l.title ?? "");
    const split = title.lastIndexOf("::");
    const scoped = split > 0 && split < title.length - 2;
    return {
        id: l.id,
        title,
        color: safeColor(l.color, "#808080"),
        textColor: safeColor(l.textColor, "#ffffff"),
        description: l.description ?? "",
        scope: scoped ? title.slice(0, split) : null,
        value: scoped ? title.slice(split + 2) : null,
    };
}

const normalizeMilestone = (m) => m && { id: m.id, title: m.title, state: m.state, dueDate: m.dueDate ?? null, startDate: m.startDate ?? null };

// GitLab reports link types as free-form strings ("relates_to", "blocks", "is_blocked_by"); callers get related|blocks|blocked_by.
function normalizeLinkType(value) {
    const type = String(value ?? "").toLowerCase().replace(/[\s-]/g, "_");
    return type.includes("blocked_by") ? "blocked_by" : type === "blocks" ? "blocks" : "related";
}

function normalizeMini(n) {
    return n && { id: n.id, iid: Number(n.iid), title: n.title, state: stateOf(n.state), webUrl: n.webUrl ?? null, type: n.workItemType?.name ?? null, iconName: n.workItemType?.iconName ?? null };
}

export function normalizeItem(node, host = "gitlab.com") {
    const w = widgetsOf(node);
    return {
        id: node.id,
        iid: Number(node.iid),
        title: node.title,
        state: stateOf(node.state),
        confidential: Boolean(node.confidential),
        webUrl: node.webUrl ?? null,
        createdAt: node.createdAt ?? null,
        updatedAt: node.updatedAt ?? null,
        closedAt: node.closedAt ?? null,
        comments: node.userDiscussionsCount ?? 0,
        type: { id: node.workItemType?.id ?? null, name: node.workItemType?.name ?? "Issue", iconName: node.workItemType?.iconName ?? null },
        labels: nodesOf(w.LABELS?.labels).map(normalizeLabel),
        assignees: nodesOf(w.ASSIGNEES?.assignees).map((u) => normalizeUser(u, host)),
        milestone: normalizeMilestone(w.MILESTONE?.milestone) ?? null,
        startDate: w.START_AND_DUE_DATE?.startDate ?? null,
        dueDate: w.START_AND_DUE_DATE?.dueDate ?? null,
        parent: normalizeMini(w.HIERARCHY?.parent) ?? null,
        hasChildren: Boolean(w.HIERARCHY?.hasChildren),
        blocked: Boolean(w.LINKED_ITEMS?.blocked),
    };
}

function normalizeNote(n, host) {
    return { id: n.id, body: n.body ?? "", createdAt: n.createdAt ?? null, updatedAt: n.updatedAt ?? null, internal: Boolean(n.internal), author: normalizeUser(n.author, host) ?? null };
}

export function normalizeDetail(node, host = "gitlab.com") {
    const w = widgetsOf(node);
    const permissions = node.userPermissions ?? {};
    return {
        ...normalizeItem(node, host),
        description: node.description ?? "",
        author: normalizeUser(node.author, host) ?? null,
        edited: Boolean(w.DESCRIPTION?.edited),
        lastEditedAt: w.DESCRIPTION?.lastEditedAt ?? null,
        lastEditedBy: w.DESCRIPTION?.lastEditedBy?.name ?? w.DESCRIPTION?.lastEditedBy?.username ?? null,
        tasks: w.DESCRIPTION?.taskCompletionStatus ? { total: w.DESCRIPTION.taskCompletionStatus.count, done: w.DESCRIPTION.taskCompletionStatus.completedCount } : null,
        children: nodesOf(w.HIERARCHY?.children).map(normalizeMini),
        linked: nodesOf(w.LINKED_ITEMS?.linkedItems).map((l) => ({ linkId: l.linkId, type: normalizeLinkType(l.linkType), item: normalizeMini(l.workItem) })).filter((l) => l.item),
        blockedByCount: w.LINKED_ITEMS?.blockedByCount ?? 0,
        blockingCount: w.LINKED_ITEMS?.blockingCount ?? 0,
        locked: Boolean(w.NOTES?.discussionLocked),
        // Which widgets this work item type has, so the UI only offers properties that can actually be edited.
        supports: { labels: Boolean(w.LABELS), assignees: Boolean(w.ASSIGNEES), milestone: Boolean(w.MILESTONE), dates: Boolean(w.START_AND_DUE_DATE), hierarchy: Boolean(w.HIERARCHY), links: Boolean(w.LINKED_ITEMS), notes: Boolean(w.NOTES) },
        discussions: nodesOf(w.NOTES?.discussions)
            .map((d) => ({ id: d.id, notes: nodesOf(d.notes).map((n) => normalizeNote(n, host)) }))
            .filter((d) => d.notes.length),
        permissions: {
            update: permissions.updateWorkItem !== false,
            comment: permissions.createNote !== false,
            link: permissions.adminWorkItemLink !== false,
            setParent: permissions.adminParentLink !== false,
        },
    };
}

/**
 * Reads the hierarchy rules and the scoped-label flag out of a `typeRules` response. Types that are not available in this
 * project (an Epic can be a Ticket's parent, but epics live in groups) are dropped so every name listed can be used.
 * Returns null when the response has no usable data.
 */
export function normalizeTypeRules(data) {
    const nodes = nodesOf(data?.project?.workItemTypes);
    if (!nodes.length) return null;
    const available = new Set(nodes.map((node) => node.name));
    const only = (connection) => nodesOf(connection).map((n) => n.name).filter((name) => available.has(name));
    const byName = new Map();
    let scoped = null;
    for (const node of nodes) {
        const definitions = (node.widgetDefinitions ?? []).filter(Boolean);
        const hierarchy = definitions.find((w) => w.type === "HIERARCHY");
        if (hierarchy?.allowedChildTypes && hierarchy.allowedParentTypes) byName.set(node.name, { childTypes: only(hierarchy.allowedChildTypes), parentTypes: only(hierarchy.allowedParentTypes) });
        const labels = definitions.find((w) => w.type === "LABELS");
        if (typeof labels?.allowsScopedLabels === "boolean") scoped = scoped === true || labels.allowsScopedLabels;
    }
    return { byName, scoped };
}

function normalizeMeta(data, host, rules = null) {
    const project = data.project;
    const labels = nodesOf(project.labels).map(normalizeLabel);
    const members = new Map();
    for (const node of nodesOf(project.projectMembers)) {
        const u = normalizeUser(node.user, host);
        if (u && !members.has(u.id)) members.set(u.id, u);
    }
    return {
        project: { id: project.id, name: project.name, fullPath: project.fullPath, webUrl: project.webUrl },
        host,
        user: normalizeUser(data.currentUser, host) ?? null,
        // childTypes/parentTypes are null when GitLab did not say, which callers treat as "no restriction".
        types: nodesOf(project.workItemTypes).map((t) => {
            const rule = rules?.byName.get(t.name);
            return { id: t.id, name: t.name, iconName: t.iconName ?? null, childTypes: rule?.childTypes ?? null, parentTypes: rule?.parentTypes ?? null };
        }),
        scopedLabels: rules?.scoped ?? null,
        labels,
        scopes: [...new Set(labels.map((l) => l.scope).filter(Boolean))].sort(),
        members: [...members.values()],
        milestones: nodesOf(project.milestones).map(normalizeMilestone),
        truncated: Boolean(project.labels?.pageInfo?.hasNextPage || project.projectMembers?.pageInfo?.hasNextPage || project.milestones?.pageInfo?.hasNextPage),
    };
}

/** Smaller shape used for agent-facing results. */
export function compactItem(item) {
    return {
        iid: item.iid,
        title: item.title,
        state: item.state,
        type: item.type.name,
        labels: item.labels.map((l) => l.title),
        assignees: item.assignees.map((u) => u.username),
        milestone: item.milestone?.title ?? null,
        startDate: item.startDate,
        dueDate: item.dueDate,
        parent: item.parent?.iid ?? null,
        confidential: item.confidential,
        comments: item.comments,
        url: item.webUrl,
    };
}

// ---------------------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------------------

const invalid = (message) => new GitLabError("invalid", message);

export const SORTS = {
    updated_desc: "UPDATED_DESC",
    updated_asc: "UPDATED_ASC",
    created_desc: "CREATED_DESC",
    created_asc: "CREATED_ASC",
    title_asc: "TITLE_ASC",
    title_desc: "TITLE_DESC",
    due_asc: "DUE_DATE_ASC",
    due_desc: "DUE_DATE_DESC",
};
const TYPE_ENUM = { issue: "ISSUE", task: "TASK", incident: "INCIDENT", ticket: "TICKET", "test case": "TEST_CASE", requirement: "REQUIREMENT", epic: "EPIC", objective: "OBJECTIVE", "key result": "KEY_RESULT" };
const STATES = { open: "opened", opened: "opened", closed: "closed", all: "all" };
const LINK_TYPES = { related: "RELATED", blocks: "BLOCKS", blocked_by: "BLOCKED_BY" };

const asList = (value) => (value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);

export function parseIid(value) {
    const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/^#/, ""));
    if (!Number.isSafeInteger(n) || n < 1) throw invalid(`"${value}" is not a valid work item number.`);
    return n;
}

function parseDate(value, field) {
    if (value === undefined || value === null || value === "") return null;
    const text = String(value);
    const time = Date.parse(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== text) {
        throw invalid(`${field} must be a date like 2026-01-31 (or empty to clear it).`);
    }
    return text;
}

function parseTitle(value) {
    const title = String(value ?? "").trim();
    if (!title) throw invalid("A title is required.");
    if (title.length > 255) throw invalid("The title can be at most 255 characters.");
    return title;
}

function parseText(value, field) {
    const text = String(value ?? "");
    if (text.length > 1_000_000) throw invalid(`${field} is too long.`);
    return text;
}

/** Converts the UI/agent filter object into GraphQL variables for `Project.workItems`. */
export function buildListVariables(filter = {}) {
    const v = {};
    const stateKey = String(filter.state ?? "open").toLowerCase();
    if (!(stateKey in STATES)) throw invalid(`Unknown state "${filter.state}". Use open, closed or all.`);
    v.state = STATES[stateKey];

    const search = String(filter.search ?? "").trim();
    if (/^#\d+$/.test(search)) v.iids = [search.slice(1)];
    else if (search) Object.assign(v, { search, in: ["TITLE", "DESCRIPTION"] });

    const types = asList(filter.type).map((t) => {
        const key = TYPE_ENUM[t.toLowerCase().replace(/[_-]/g, " ")];
        if (!key) throw invalid(`Unknown work item type "${t}".`);
        return key;
    });
    if (types.length) v.types = types;

    const labels = asList(filter.label ?? filter.labels);
    if (labels.length) v.labelName = labels;

    const assignee = String(filter.assignee ?? "").trim().replace(/^@/, "");
    if (assignee) {
        if (assignee.toLowerCase() === "none") v.assigneeWildcardId = "NONE";
        else if (assignee.toLowerCase() === "any") v.assigneeWildcardId = "ANY";
        else v.assigneeUsernames = [assignee];
    }

    const milestone = String(filter.milestone ?? "").trim();
    if (milestone) {
        const wildcard = { none: "NONE", any: "ANY", started: "STARTED", upcoming: "UPCOMING" }[milestone.toLowerCase()];
        if (wildcard) v.milestoneWildcardId = wildcard;
        else v.milestoneTitle = [milestone];
    }

    const author = String(filter.author ?? "").trim().replace(/^@/, "");
    if (author) v.authorUsername = author;

    const sortKey = String(filter.sort ?? "updated_desc").toLowerCase();
    if (!(sortKey in SORTS)) throw invalid(`Unknown sort "${filter.sort}".`);
    v.sort = SORTS[sortKey];
    return v;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/** Creates a work-item service bound to one GitLab project. `run` can be replaced in tests. */
export function createService({ host, projectPath, run = runGlab, now = () => Date.now() }) {
    const ids = new Map();
    let metaCache = null;
    let metaInFlight = null;

    const call = (query, variables) => graphql(host, query, variables, run);
    const notFound = () => new GitLabError("not_found", `Project "${projectPath}" was not found on ${host}, or your glab account cannot access it.`);
    const projectApiPath = `projects/${encodeURIComponent(projectPath)}`;
    const mergeRequestIid = (value) => {
        const iid = typeof value === "number" ? value : Number(String(value ?? "").replace(/^!/, ""));
        if (!Number.isSafeInteger(iid) || iid < 1) throw invalid(`"${value}" is not a valid merge request number.`);
        return iid;
    };
    const branchName = (value, field) => {
        const branch = String(value ?? "").trim();
        if (!branch) throw invalid(`${field} is required.`);
        if (branch.length > 255) throw invalid(`${field} is too long (max 255 characters).`);
        return branch;
    };
    const labelNames = (value) => {
        const labels = asList(value);
        if (labels.length > 50 || labels.some((label) => label.length > 255)) throw invalid("At most 50 labels of 255 characters each are supported.");
        return labels;
    };

    async function rest(path, { method = "GET", query, body } = {}) {
        const queryString = query ? `?${new URLSearchParams(query)}` : "";
        const args = ["api", `${projectApiPath}${path}${queryString}`, "--hostname", host];
        if (method !== "GET") args.push("--method", method);
        if (body !== undefined) args.push("--input", "-");
        const result = await run(args, { stdin: body === undefined ? "" : JSON.stringify(body) });
        if (result.code !== 0) throw classifyFailure(result.code, result.stderr, result.stdout);
        try {
            return result.stdout.trim() ? JSON.parse(result.stdout) : null;
        } catch {
            throw new GitLabError("bad_response", "GitLab returned an invalid response for the merge request operation.");
        }
    }

    function normalizeMergeRequest(mr) {
        if (!mr || typeof mr !== "object" || !Number.isInteger(Number(mr.iid))) {
            throw new GitLabError("bad_response", "GitLab returned an incomplete merge request.");
        }
        return {
            iid: Number(mr.iid),
            title: String(mr.title ?? ""),
            description: String(mr.description ?? ""),
            state: String(mr.state ?? "opened").toLowerCase(),
            webUrl: absoluteUrl(host, mr.web_url),
            createdAt: mr.created_at ?? null,
            updatedAt: mr.updated_at ?? null,
            mergedAt: mr.merged_at ?? null,
            closedAt: mr.closed_at ?? null,
            sourceBranch: String(mr.source_branch ?? ""),
            targetBranch: String(mr.target_branch ?? ""),
            draft: Boolean(mr.draft ?? mr.work_in_progress),
            mergeStatus: String(mr.detailed_merge_status ?? mr.merge_status ?? ""),
            author: mr.author ? normalizeUser(mr.author, host) : null,
            assignees: (mr.assignees ?? (mr.assignee ? [mr.assignee] : [])).filter(Boolean).map((user) => normalizeUser(user, host)),
            reviewers: (mr.reviewers ?? []).filter(Boolean).map((user) => normalizeUser(user, host)),
            labels: (mr.labels ?? []).map((label) => typeof label === "string" ? label : String(label?.title ?? "")),
            comments: Number(mr.user_notes_count ?? 0),
        };
    }

    const mergeRequestNotes = (notes) => (Array.isArray(notes) ? notes : []).filter((note) => !note.system).map((note) => ({
        id: note.id,
        body: String(note.body ?? ""),
        createdAt: note.created_at ?? null,
        author: note.author ? normalizeUser(note.author, host) : null,
        internal: false,
    }));

    async function listMergeRequests(filter = {}, { first = 50, page = 1 } = {}) {
        const state = String(filter.state ?? "opened").toLowerCase();
        if (!["opened", "closed", "merged", "all"].includes(state)) throw invalid('Merge request state must be "opened", "closed", "merged" or "all".');
        const requestedSize = Number(first);
        if (!Number.isSafeInteger(requestedSize) || requestedSize < 1) throw invalid("Merge request page size must be a positive integer.");
        const perPage = Math.min(requestedSize, 100);
        const pageNumber = Number(page);
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw invalid("Merge request page must be a positive integer.");
        const query = { state, per_page: String(perPage), page: String(pageNumber), order_by: "updated_at", sort: "desc" };
        const search = String(filter.search ?? "").trim();
        if (search) query.search = search.slice(0, 200);
        const rows = await rest("/merge_requests", { query });
        if (!Array.isArray(rows)) throw new GitLabError("bad_response", "GitLab did not return a merge request list.");
        const hasNextPage = rows.length === perPage;
        return { items: rows.map(normalizeMergeRequest), total: null, hasNextPage, nextPage: hasNextPage ? pageNumber + 1 : null };
    }

    async function getMergeRequest(iid) {
        const number = mergeRequestIid(iid);
        const [raw, notes] = await Promise.all([
            rest(`/merge_requests/${number}`),
            rest(`/merge_requests/${number}/notes`, { query: { per_page: "100", sort: "asc" } }),
        ]);
        if (!raw) throw new GitLabError("not_found", `Merge request !${number} does not exist in ${projectPath}.`);
        return { ...normalizeMergeRequest(raw), discussions: mergeRequestNotes(notes) };
    }

    async function createMergeRequest(input = {}) {
        const title = parseTitle(input.title);
        const sourceBranch = branchName(input.sourceBranch, "A source branch");
        const targetBranch = branchName(input.targetBranch, "A target branch");
        const payload = {
            title,
            source_branch: sourceBranch,
            target_branch: targetBranch,
            ...(input.description !== undefined && { description: parseText(input.description, "The description") }),
            ...(input.draft !== undefined && { draft: Boolean(input.draft) }),
            ...(input.labels !== undefined && { labels: labelNames(input.labels).join(",") }),
        };
        return normalizeMergeRequest(await rest("/merge_requests", { method: "POST", body: payload }));
    }

    async function updateMergeRequest(iid, patch = {}) {
        const number = mergeRequestIid(iid);
        const payload = {};
        if (patch.title !== undefined) payload.title = parseTitle(patch.title);
        if (patch.description !== undefined) payload.description = parseText(patch.description, "The description");
        if (patch.targetBranch !== undefined) {
            payload.target_branch = branchName(patch.targetBranch, "A target branch");
        }
        if (patch.draft !== undefined) payload.draft = Boolean(patch.draft);
        if (patch.labels !== undefined) payload.labels = labelNames(patch.labels).join(",");
        if (patch.state !== undefined) {
            if (!["opened", "open", "closed", "close", "reopen"].includes(String(patch.state).toLowerCase())) throw invalid('state must be "opened" or "closed".');
            payload.state_event = /^clos/i.test(patch.state) ? "close" : "reopen";
        }
        if (!Object.keys(payload).length) throw invalid("Nothing to update.");
        return normalizeMergeRequest(await rest(`/merge_requests/${number}`, { method: "PUT", body: payload }));
    }

    async function commentMergeRequest(iid, body) {
        const text = parseText(body, "The comment").trim();
        if (!text) throw invalid("A comment cannot be empty.");
        const note = await rest(`/merge_requests/${mergeRequestIid(iid)}/notes`, { method: "POST", body: { body: text } });
        return mergeRequestNotes([note])[0] ?? null;
    }

    async function approveMergeRequest(iid) {
        await rest(`/merge_requests/${mergeRequestIid(iid)}/approve`, { method: "POST", body: {} });
        return getMergeRequest(iid);
    }

    async function mergeMergeRequest(iid, options = {}) {
        const number = mergeRequestIid(iid);
        const body = {};
        if (options.mergeWhenPipelineSucceeds !== undefined) body.merge_when_pipeline_succeeds = Boolean(options.mergeWhenPipelineSucceeds);
        if (options.shouldRemoveSourceBranch !== undefined) body.should_remove_source_branch = Boolean(options.shouldRemoveSourceBranch);
        const result = await rest(`/merge_requests/${number}/merge`, { method: "PUT", body });
        return result ? normalizeMergeRequest(result) : getMergeRequest(number);
    }

    function remember(item) {
        ids.set(item.iid, item.id);
        return item;
    }

    async function meta({ force = false } = {}) {
        if (!force && metaCache && now() - metaCache.at < META_TTL_MS) return metaCache.value;
        if (!metaInFlight) {
            const rules = call(DOCS.typeRules, { fullPath: projectPath }).then(normalizeTypeRules).catch(() => null);
            metaInFlight = Promise.all([call(DOCS.meta, { fullPath: projectPath }), rules])
                .then(([data, typeRules]) => {
                    if (!data.project) throw notFound();
                    metaCache = { at: now(), value: normalizeMeta(data, host, typeRules) };
                    return metaCache.value;
                })
                .finally(() => {
                    metaInFlight = null;
                });
        }
        return metaInFlight;
    }

    async function resolve(kind, names, find) {
        const wanted = asList(names);
        if (!wanted.length) return [];
        const lookup = (m, name) => find(m, name.replace(/^@/, "").toLowerCase());
        let current = await meta();
        let found = wanted.map((name) => lookup(current, name));
        if (found.some((hit) => !hit)) {
            current = await meta({ force: true });
            found = wanted.map((name) => lookup(current, name));
        }
        const missing = wanted.filter((_, i) => !found[i]);
        if (missing.length) throw new GitLabError("invalid", `Unknown ${kind}: ${missing.join(", ")}.`);
        return found.map((hit) => hit.id);
    }

    const labelIds = (names) => resolve("label", names, (m, key) => m.labels.find((l) => l.title.toLowerCase() === key));
    const userIds = (names) => resolve("user", names, (m, key) => m.members.find((u) => u.username.toLowerCase() === key) ?? (m.user?.username.toLowerCase() === key ? m.user : undefined));
    const milestoneId = async (name) => (await resolve("milestone", [name], (m, key) => m.milestones.find((x) => x.title.toLowerCase() === key)))[0];

    async function idOf(iid) {
        const number = parseIid(iid);
        if (ids.has(number)) return ids.get(number);
        const data = await call(DOCS.idLookup, { fullPath: projectPath, iid: String(number) });
        if (!data.project) throw notFound();
        const node = nodesOf(data.project.workItems)[0];
        if (!node) throw new GitLabError("not_found", `Work item #${number} does not exist in ${projectPath}.`);
        ids.set(number, node.id);
        return node.id;
    }

    function unwrap(payload, what) {
        if (payload?.errors?.length) throw new GitLabError("mutation_failed", payload.errors.join("; "));
        if (!payload?.workItem) throw new GitLabError("mutation_failed", payload?.message || `GitLab did not return the ${what}.`);
        return remember(normalizeDetail(payload.workItem, host));
    }

    async function list(filter = {}, { first = 50, after } = {}) {
        const variables = { fullPath: projectPath, first: Math.min(Math.max(Number(first) || 50, 1), 100), ...buildListVariables(filter) };
        if (after) variables.after = String(after);
        if (String(filter.assignee ?? "").trim().replace(/^@/, "").toLowerCase() === "me") {
            const me = (await meta()).user;
            if (!me) throw new GitLabError("auth", "Cannot resolve “me”: no authenticated GitLab user.");
            delete variables.assigneeWildcardId;
            variables.assigneeUsernames = [me.username];
        }
        const data = await call(DOCS.list, variables);
        if (!data.project) throw notFound();
        const connection = data.project.workItems;
        return {
            items: nodesOf(connection).map((n) => remember(normalizeItem(n, host))),
            total: connection.count ?? 0,
            hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
            endCursor: connection.pageInfo?.endCursor ?? null,
        };
    }

    async function get(iid) {
        const number = parseIid(iid);
        const data = await call(DOCS.detail, { fullPath: projectPath, iid: String(number) });
        if (!data.project) throw notFound();
        const node = nodesOf(data.project.workItems)[0];
        if (!node) throw new GitLabError("not_found", `Work item #${number} does not exist in ${projectPath}.`);
        return remember(normalizeDetail(node, host));
    }

    async function create(input = {}) {
        const title = parseTitle(input.title);
        const m = await meta();
        const typeName = String(input.type || "Issue").toLowerCase();
        const type = m.types.find((t) => t.name.toLowerCase() === typeName);
        if (!type) throw invalid(`Unknown work item type "${input.type}". Available: ${m.types.map((t) => t.name).join(", ")}.`);

        const payload = { namespacePath: projectPath, title, workItemTypeId: type.id };
        if (input.description) payload.descriptionWidget = { description: parseText(input.description, "The description") };
        if (input.confidential) payload.confidential = true;
        const labels = asList(input.labels);
        if (labels.length) payload.labelsWidget = { labelIds: await labelIds(labels) };
        const assignees = asList(input.assignees);
        if (assignees.length) payload.assigneesWidget = { assigneeIds: await userIds(assignees) };
        if (input.milestone) payload.milestoneWidget = { milestoneId: await milestoneId(String(input.milestone)) };
        const startDate = parseDate(input.startDate, "startDate");
        const dueDate = parseDate(input.dueDate, "dueDate");
        if (startDate || dueDate) payload.startAndDueDateWidget = { ...(startDate && { startDate }), ...(dueDate && { dueDate }) };
        if (input.parent) payload.hierarchyWidget = { parentId: await idOf(input.parent) };

        const data = await call(DOCS.create, { input: payload });
        return unwrap(data.workItemCreate, "new work item");
    }

    async function update(iid, patch = {}) {
        const input = { id: await idOf(iid) };
        if (patch.title !== undefined) input.title = parseTitle(patch.title);
        if (patch.state !== undefined) {
            if (!["open", "opened", "closed", "close", "reopen"].includes(String(patch.state).toLowerCase())) throw invalid('state must be "open" or "closed".');
            input.stateEvent = /^clos/i.test(patch.state) ? "CLOSE" : "REOPEN";
        }
        if (patch.confidential !== undefined) input.confidential = Boolean(patch.confidential);
        if (patch.description !== undefined) input.descriptionWidget = { description: parseText(patch.description, "The description") };
        if (patch.assignees !== undefined) input.assigneesWidget = { assigneeIds: await userIds(patch.assignees) };
        const add = asList(patch.addLabels);
        const remove = asList(patch.removeLabels);
        if (add.length || remove.length) {
            input.labelsWidget = {};
            if (add.length) input.labelsWidget.addLabelIds = await labelIds(add);
            if (remove.length) input.labelsWidget.removeLabelIds = await labelIds(remove);
        }
        if (patch.milestone !== undefined) input.milestoneWidget = { milestoneId: patch.milestone ? await milestoneId(String(patch.milestone)) : null };
        if (patch.startDate !== undefined || patch.dueDate !== undefined) {
            input.startAndDueDateWidget = {};
            if (patch.startDate !== undefined) input.startAndDueDateWidget.startDate = parseDate(patch.startDate, "startDate");
            if (patch.dueDate !== undefined) input.startAndDueDateWidget.dueDate = parseDate(patch.dueDate, "dueDate");
        }
        if (patch.parent !== undefined) input.hierarchyWidget = { parentId: patch.parent ? await idOf(patch.parent) : null };
        if (Object.keys(input).length === 1) throw invalid("Nothing to update.");

        const data = await call(DOCS.update, { input });
        return unwrap(data.workItemUpdate, "updated work item");
    }

    async function comment(iid, body) {
        const text = parseText(body, "The comment").trim();
        if (!text) throw invalid("A comment cannot be empty.");
        const data = await call(DOCS.note, { input: { noteableId: await idOf(iid), body: text } });
        const payload = data.createNote;
        if (payload?.errors?.length) throw new GitLabError("mutation_failed", payload.errors.join("; "));
        if (!payload?.note) throw new GitLabError("mutation_failed", "GitLab did not return the new comment (it may have been a quick action).");
        return normalizeNote(payload.note, host);
    }

    async function link(iid, target, type = "related") {
        const linkType = LINK_TYPES[String(type).toLowerCase().replace(/[\s-]/g, "_")];
        if (!linkType) throw invalid('Link type must be "related", "blocks" or "blocked_by".');
        const source = parseIid(iid);
        const other = parseIid(target);
        if (source === other) throw invalid("A work item cannot be linked to itself.");
        const data = await call(DOCS.addLinks, { input: { id: await idOf(source), workItemsIds: [await idOf(other)], linkType } });
        return unwrap(data.workItemAddLinkedItems, "linked work item");
    }

    async function unlink(iid, target) {
        const source = parseIid(iid);
        const data = await call(DOCS.removeLinks, { input: { id: await idOf(source), workItemsIds: [await idOf(target)] } });
        return unwrap(data.workItemRemoveLinkedItems, "work item");
    }

    return { host, projectPath, meta, list, get, create, update, comment, link, unlink, listMergeRequests, getMergeRequest, createMergeRequest, updateMergeRequest, commentMergeRequest, approveMergeRequest, mergeMergeRequest };
}

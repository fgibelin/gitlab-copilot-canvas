// Agent-facing actions of the canvas. Every handler talks to the same workbench the panel uses, so whatever the agent
// does shows up live in the panel, and the agent can see and steer what the user is looking at.
import { GitLabError, SORTS, compactItem } from "./gitlab.mjs";

const MAX_DESCRIPTION_CHARS = 30_000;
const MAX_COMMENT_CHARS = 4_000;
const MAX_COMMENTS = 30;

// ---- schema building blocks -----------------------------------------------------------------------------------------
const object = (properties, required) => ({ type: "object", properties, ...(required?.length && { required }), additionalProperties: false });
const text = (description, maxLength = 255) => ({ type: "string", maxLength, description });
const names = (description, maxItems = 50) => ({ type: "array", items: { type: "string", minLength: 1, maxLength: 255 }, maxItems, description });
const day = (what) => ({ type: "string", pattern: "^(\\d{4}-\\d{2}-\\d{2})?$", description: `${what} as YYYY-MM-DD. An empty string clears it.` });
const IID = { type: "integer", minimum: 1, description: "The work item number within the project (the N in #N)." };
const LINK_TYPE = { type: "string", enum: ["related", "blocks", "blocked_by"], description: '"blocks": `iid` blocks `target`. "blocked_by": `iid` is blocked by `target`. "related": a plain relation.' };

const FILTERS = {
    state: { type: "string", enum: ["open", "closed", "all"], description: "Which items to show." },
    type: text("Work item type name such as Issue, Task, Incident or Ticket. Empty = every type.", 50),
    label: names("Only items that carry ALL of these labels (scoped labels look like scope::value).", 20),
    assignee: text("A username, or none / any / me. Empty = anyone.", 100),
    milestone: text("A milestone title, or none / any / started / upcoming. Empty = any.", 255),
    search: text("Text to find in titles and descriptions. A plain #12 jumps to item 12.", 200),
    sort: { type: "string", enum: Object.keys(SORTS), description: "Sort order." },
};

const WRITABLE = {
    title: text("Title (1-255 characters).", 255),
    description: text("Markdown description.", 1_000_000),
    confidential: { type: "boolean", description: "Whether the item is confidential." },
    milestone: text("Milestone title (must exist).", 255),
    startDate: day("Start date"),
    dueDate: day("Due date"),
};

// ---- agent-friendly result shapes -----------------------------------------------------------------------------------
const clip = (value, max) => {
    const s = String(value ?? "");
    return s.length > max ? `${s.slice(0, max)}\n[... ${s.length - max} more characters not shown]` : s;
};
const brief = (item) => ({ iid: item.iid, title: item.title, state: item.state, type: item.type });
const linksOf = (linked) => linked.map((link) => ({ link: link.type, ...brief(link.item) }));

function detailForAgent(d) {
    const notes = d.discussions.flatMap((thread) => thread.notes).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const shown = notes.slice(-MAX_COMMENTS);
    return {
        ...compactItem(d),
        description: clip(d.description, MAX_DESCRIPTION_CHARS),
        author: d.author?.username ?? null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        closedAt: d.closedAt,
        blocked: d.blocked,
        taskCompletion: d.tasks,
        children: d.children.map(brief),
        linked: linksOf(d.linked),
        comments: shown.map((n) => ({ author: n.author?.username ?? null, at: n.createdAt, internal: n.internal, body: clip(n.body, MAX_COMMENT_CHARS) })),
        olderCommentsNotShown: notes.length - shown.length,
        canEdit: d.permissions.update,
    };
}

// ---- errors ---------------------------------------------------------------------------------------------------------
export function toCanvasError(error, action, log = () => {}, ErrorClass = GitLabError) {
    if (error instanceof ErrorClass) return error;
    if (error instanceof GitLabError) return new ErrorClass(error.code, error.message);
    log("error", `${action} failed: ${error?.stack ?? error}`);
    return new ErrorClass("internal", `Unexpected error in ${action}. See the extension log.`);
}

/**
 * @param {{ workbenchFor: (ctx: object) => object, log?: (level: string, message: string) => void, ErrorClass?: typeof GitLabError, beforeRun?: Function }} deps
 */
export function buildActions({ workbenchFor, log = () => {}, ErrorClass = GitLabError, beforeRun = () => {} }) {
    const action = (name, description, inputSchema, run) => ({
        name,
        description,
        ...(inputSchema && { inputSchema }),
        handler: async (ctx) => {
            try {
                const workbench = workbenchFor(ctx);
                await workbench.init();
                beforeRun(workbench, ctx, name);
                return await run({ wb: workbench, input: ctx.input && typeof ctx.input === "object" ? ctx.input : {} });
            } catch (error) {
                throw toCanvasError(error, name, log, ErrorClass);
            }
        },
    });

    return [
        action("get_project_info", "Lists what exists in the GitLab project: work item types (and which types may be parents or children of which), labels (including scoped label groups), members, open milestones and the signed-in user. Read it before using a label, assignee, milestone or parent.", object({ refresh: { type: "boolean", description: "Bypass the 5-minute cache." } }), async ({ wb, input }) => {
            const meta = await wb.meta({ force: input.refresh === true });
            const ruled = meta.types.filter((t) => t.childTypes && t.parentTypes);
            return {
                project: meta.project.fullPath,
                url: meta.project.webUrl,
                signedInAs: meta.user?.username ?? null,
                types: meta.types.map((t) => t.name),
                hierarchy: ruled.length ? Object.fromEntries(ruled.map((t) => [t.name, { canHaveChildren: t.childTypes, canBeChildOf: t.parentTypes }])) : undefined,
                labels: meta.labels.map((l) => ({ name: l.title, description: l.description || undefined })),
                labelScopes: meta.scopes,
                scopedLabelsExclusive: meta.scopedLabels ?? undefined,
                members: meta.members.map((m) => ({ username: m.username, name: m.name })),
                milestones: meta.milestones.map((m) => ({ title: m.title, dueDate: m.dueDate })),
                incomplete: meta.truncated,
            };
        }),

        action("list_work_items", "Searches work items with explicit filters and returns a compact page (default 20, newest first). Use `fromView` to search with the filters the user currently has applied in the panel.", object({
            ...FILTERS,
            fromView: { type: "boolean", description: "Start from the panel's current filters; fields given here override them." },
            first: { type: "integer", minimum: 1, maximum: 50, description: "Page size (default 20)." },
            after: text("`nextCursor` from a previous page.", 500),
        }), async ({ wb, input }) => {
            const { fromView = false, first = 20, after, ...filters } = input;
            const base = fromView ? wb.getView().filters : {};
            const page = await wb.list({ ...base, ...filters }, { first, after });
            return { total: page.total, returned: page.items.length, nextCursor: page.hasNextPage ? page.endCursor : null, items: page.items.map(compactItem) };
        }),

        action("get_work_item", "Reads one work item in full: description, child tasks, linked items and the latest comments.", object({ iid: IID }, ["iid"]), async ({ wb, input }) => detailForAgent(await wb.get(input.iid))),

        action("create_work_item", "Creates a work item. Labels, assignees and the milestone must already exist (see get_project_info). Type defaults to Issue.", object({
            title: WRITABLE.title,
            type: text("Work item type name. Default: Issue.", 50),
            description: WRITABLE.description,
            labels: names("Label names."),
            assignees: names("Usernames.", 20),
            milestone: WRITABLE.milestone,
            startDate: WRITABLE.startDate,
            dueDate: WRITABLE.dueDate,
            parent: { ...IID, description: "Make the new item a child of this work item." },
            confidential: WRITABLE.confidential,
        }, ["title"]), async ({ wb, input }) => compactItem(await wb.create(input, "agent"))),

        action("update_work_item", "Changes a work item. Only the fields you pass are touched: `assignees` replaces the list, `addLabels`/`removeLabels` adjust labels, an empty string clears milestone and dates, `parent: 0` detaches it from its parent, `state: closed` closes it.", object({
            iid: IID,
            title: WRITABLE.title,
            description: WRITABLE.description,
            state: { type: "string", enum: ["open", "closed"], description: "Reopen or close the item." },
            confidential: WRITABLE.confidential,
            assignees: names("The complete list of assignee usernames. An empty list unassigns everyone.", 20),
            addLabels: names("Labels to add."),
            removeLabels: names("Labels to remove."),
            milestone: { ...WRITABLE.milestone, description: "Milestone title (must exist). An empty string clears it." },
            startDate: WRITABLE.startDate,
            dueDate: WRITABLE.dueDate,
            parent: { type: "integer", minimum: 0, description: "Number of the new parent work item; 0 removes the parent." },
        }, ["iid"]), async ({ wb, input }) => {
            const { iid, ...patch } = input;
            if (!Object.keys(patch).length) throw new GitLabError("invalid", "Nothing to change: pass at least one field besides iid.");
            if (patch.parent === 0) patch.parent = "";
            return compactItem(await wb.update(iid, patch, "agent"));
        }),

        action("add_comment", "Posts a Markdown comment on a work item. It is published under the signed-in GitLab user's name.", object({ iid: IID, body: text("Markdown comment text.", 1_000_000) }, ["iid", "body"]), async ({ wb, input }) => {
            if (!input.body.trim()) throw new GitLabError("invalid", "The comment is empty.");
            const note = await wb.comment(input.iid, input.body, "agent");
            return { iid: input.iid, commentId: note.id, createdAt: note.createdAt };
        }),

        action("link_work_items", "Links two work items (related, blocks, or blocked_by).", object({ iid: IID, target: { ...IID, description: "The other work item's number." }, type: LINK_TYPE }, ["iid", "target"]), async ({ wb, input }) => {
            const updated = await wb.link(input.iid, input.target, input.type ?? "related", "agent");
            return { iid: updated.iid, linked: linksOf(updated.linked) };
        }),

        action("unlink_work_items", "Removes the link between two work items.", object({ iid: IID, target: { ...IID, description: "The linked work item's number." } }, ["iid", "target"]), async ({ wb, input }) => {
            const updated = await wb.unlink(input.iid, input.target, "agent");
            return { iid: updated.iid, linked: linksOf(updated.linked) };
        }),

        action("get_view", "Returns what the user is looking at: project, list or board mode, grouping, filters and the work item open in the side panel.", undefined, async ({ wb }) => {
            const { configured, project, problem, view } = wb.describe();
            return { configured, project, problem, view };
        }),

        action("set_view", "Changes the panel's view: list or board, board grouping, and filters. Only the fields you pass change. Group the board by state, assignee, milestone, or scope:<label scope> (for example scope:workflow).", object({
            mode: { type: "string", enum: ["list", "board"], description: "Show a list or a board." },
            groupBy: text("Board columns: state, assignee, milestone or scope:<label scope>.", 100),
            filters: object(FILTERS),
        }), async ({ wb, input }) => ({ view: wb.setView(input, { broadcast: true }) })),

        action("select_work_item", "Opens a work item in the panel's side drawer so the user can read or edit it. Omit `iid` to close the drawer.", object({ iid: IID }), async ({ wb, input }) => {
            if (input.iid === undefined) {
                wb.setView({ selected: null }, { broadcast: true });
                return { selected: null };
            }
            const item = await wb.get(input.iid);
            wb.setView({ selected: input.iid }, { broadcast: true });
            return { selected: compactItem(item) };
        }),

        action("refresh", "Re-syncs the panel with GitLab now (items, the open item, labels, members, milestones). Use after changes made outside this canvas.", undefined, async ({ wb }) => {
            wb.emit("changed", { by: "agent", source: wb.instanceId, meta: true });
            return { refreshed: true, project: wb.describe().project };
        }),

        action("set_project", "Points the panel at a different GitLab project and resets its view. Accepts group/project or a project URL.", object({ project: text("group/project, or a project URL.", 300) }, ["project"]), async ({ wb, input }) => {
            const described = await wb.setProject(input.project);
            return { project: described.project, view: described.view };
        }),
    ];
}

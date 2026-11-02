// Work-item drawer: header, editable title, properties, description, child items, linked items and comments.
// It is built once per selected item and every section repaints only when its own data changed, so an open editor,
// an open picker or a half-written comment is never torn down by a background refresh.
import { api } from "./api.js";
import { avatar, dayLabel, dueStatus, fullTime, h, icon, labelChip, relTime, setChildren, stateIcon, typeIcon } from "./dom.js";
import { markdownEditor } from "./editor.js";
import { renderMarkdown } from "./md.js";
import { errorBox } from "./parts.js";
import { openPicker, togglePicker } from "./pickers.js";
import { addChild, addComment, labelScopeOf, linkItems, loadDetail, notifyError, patchItem, select, state, typeRules, unlinkItems } from "./state.js";
import { labelOption, milestoneOption, personOption } from "./toolbar.js";

const TRAIL_MAX = 30;
const LINK_GROUPS = [
    ["blocks", "Blocks"],
    ["blocked_by", "Blocked by"],
    ["related", "Related to"],
];
const LINK_PROMPT = { related: "Relates to…", blocks: "This item blocks…", blocked_by: "This item is blocked by…" };

const baseUrl = () => (state.meta?.project?.webUrl ? `${state.meta.project.webUrl.replace(/\/$/, "")}/` : null);
const time = (iso) => h("time", { datetime: iso ?? "", title: fullTime(iso) }, relTime(iso));
const muted = (text) => h("span", { class: "muted" }, text);

// A repaint replaces the focused control, which would drop keyboard focus on <body>. A control that stands for "the same
// control" before and after shares a key (data-focus-key, else aria-label, else title); data-focus-next names where focus
// goes when the control itself disappears (a removed row, a finished editor).
const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]";
const focusKey = (node) => node.dataset.focusKey ?? node.getAttribute("aria-label") ?? node.getAttribute("title");
const focusTarget = (root, key) => (key ? ([...root.querySelectorAll(FOCUSABLE)].find((node) => focusKey(node) === key) ?? null) : null);

/** After an inline editor closes, puts focus back on the control that opened it, unless the user has already moved on. */
function returnFocus(host, target) {
    const active = document.activeElement;
    if (target && (!active || active === document.body || host.contains(active))) target.focus({ preventScroll: true });
}

/** A section that repaints itself only when its signature changes (or when forced). */
function region(el, { signature, paint, frozen }) {
    let last = null;
    const run = (detail, force) => {
        if (frozen?.()) return;
        const next = JSON.stringify(signature(detail));
        if (!force && next === last) return;
        last = next;
        const held = document.activeElement !== el && el.contains(document.activeElement) ? document.activeElement : null;
        paint(el, detail);
        if (held && !held.isConnected) (focusTarget(el, focusKey(held)) ?? focusTarget(el, held.dataset.focusNext) ?? el.querySelector(FOCUSABLE))?.focus({ preventScroll: true });
    };
    return { el, update: (detail) => run(detail, false), repaint: (detail) => run(detail, true) };
}

async function attempt(work) {
    try {
        return await work();
    } catch (error) {
        notifyError(error);
        return null;
    }
}

function itemOption(item) {
    return {
        value: item.iid,
        label: `#${item.iid} ${item.title}`,
        keywords: `${item.iid} ${item.title}`,
        render: () => h("span", { class: "pick-label with-icon" }, stateIcon(item.state, { size: 14 }), h("span", { class: "pick-text" }, item.title), h("span", { class: "pick-hint" }, `#${item.iid}`)),
    };
}

const searchItems = async (query, types) => (await api.items({ state: "all", search: query, sort: "updated_desc", type: types }, { first: 20 })).items;

/** A child task can be added when the type may have Task children (or, if GitLab did not say, unless the item is itself a Task). */
function canAddTask(d) {
    const { children } = typeRules(d.type?.name);
    return d.permissions.update && (children ? children.includes("Task") : d.type?.name !== "Task");
}

function itemButton(item, ctx, { cls = "" } = {}) {
    return h("button", { class: `item-link ${cls}`.trim(), type: "button", title: `Open #${item.iid}`, onclick: () => ctx.go(item.iid) }, stateIcon(item.state, { size: 13 }), h("span", { class: "item-title" }, item.title), h("span", { class: "item-id" }, `#${item.iid}`));
}

// ---- title ----------------------------------------------------------------------------------------------------------
function titleSection(ctx) {
    let editing = false;
    const el = h("div", { class: "d-titlebar" });
    const reg = region(el, {
        frozen: () => editing,
        signature: (d) => [d.title, d.permissions.update],
        paint(node, d) {
            setChildren(node,
                h("h2", { class: "d-title" }, d.title),
                d.permissions.update ? h("button", { class: "icon-btn", type: "button", title: "Edit title", "aria-label": "Edit title", onclick: start }, icon("pencil", { size: 14 })) : null,
            );
        },
    });

    function stop() {
        editing = false;
        reg.repaint(ctx.detail);
        returnFocus(el, el.querySelector('[aria-label="Edit title"]'));
    }

    function start() {
        const d = ctx.detail;
        editing = true;
        const input = h("textarea", { class: "d-title-input", rows: 1, maxlength: 255, "aria-label": "Title", spellcheck: "true" });
        input.value = d.title;
        const error = h("div", { class: "ed-error", role: "alert", hidden: true });
        const saveBtn = h("button", { class: "btn primary small", type: "button", onclick: () => save() }, "Save");
        const cancelBtn = h("button", { class: "btn ghost small", type: "button", onclick: stop }, "Cancel");
        const fit = () => {
            input.style.height = "auto";
            // scrollHeight excludes the border; box-sizing is border-box, so add it back or a scrollbar appears.
            input.style.height = `${input.scrollHeight + (input.offsetHeight - input.clientHeight)}px`;
        };
        const busy = (flag) => {
            input.readOnly = flag;
            saveBtn.disabled = cancelBtn.disabled = flag;
        };
        let saving = false;
        async function save() {
            if (saving) return;
            const title = input.value.replace(/\s*\n\s*/g, " ").trim();
            if (!title) {
                error.textContent = "A title is required.";
                error.hidden = false;
                return;
            }
            if (title === d.title) return stop();
            saving = true;
            busy(true);
            try {
                await patchItem(ctx.iid, { title });
                stop();
            } catch (failure) {
                error.textContent = failure.message;
                error.hidden = false;
                busy(false);
                input.focus();
            } finally {
                saving = false;
            }
        }
        input.addEventListener("input", fit);
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                save();
            } else if (event.key === "Escape") {
                event.stopPropagation();
                if (!saving) stop();
            }
        });
        setChildren(el, input, error, h("div", { class: "ed-actions" }, h("span", { class: "tb-spacer" }), cancelBtn, saveBtn));
        fit();
        input.focus();
        input.select();
    }
    return reg;
}

// ---- state row ------------------------------------------------------------------------------------------------------
function statusSection(ctx) {
    let pending = false;
    return region(h("div", { class: "d-status" }), {
        signature: (d) => [d.state, d.confidential, d.blocked, d.createdAt, d.closedAt, d.author?.username, d.author?.name, d.permissions.update],
        paint(node, d) {
            const closed = d.state === "closed";
            const toggle = h("button", { class: "btn small", type: "button", disabled: !d.permissions.update, dataset: { focusKey: "state-toggle" }, onclick: async (event) => {
                if (pending) return;
                const button = event.currentTarget;
                pending = true;
                button.setAttribute("aria-busy", "true");
                await attempt(() => patchItem(ctx.iid, { state: closed ? "open" : "closed" }));
                pending = false;
                button.removeAttribute("aria-busy");
            } }, closed ? "Reopen" : "Close item");
            setChildren(node,
                h("span", { class: `pill state-${d.state}` }, stateIcon(d.state, { size: 13 }), closed ? "Closed" : "Open"),
                d.confidential ? h("span", { class: "pill confidential", title: "Only project members can see this item" }, icon("lock", { size: 12 }), "Confidential") : null,
                d.blocked ? h("span", { class: "pill blocked", title: "Blocked by another open work item" }, icon("block", { size: 12 }), "Blocked") : null,
                h("span", { class: "d-meta" }, "opened ", time(d.createdAt), d.author ? [" by ", h("strong", {}, d.author.name)] : null, closed && d.closedAt ? [" · closed ", time(d.closedAt)] : null),
                h("span", { class: "tb-spacer" }),
                toggle,
            );
        },
    });
}

// ---- properties -----------------------------------------------------------------------------------------------------
function prop(iconName, label, content, { edit, disabled = false, extra = null } = {}) {
    return h(
        "div",
        { class: "prop" },
        h("div", { class: "prop-name" }, icon(iconName, { size: 14 }), h("span", {}, label)),
        h(
            "div",
            { class: "prop-value" },
            h("div", { class: "prop-content" }, content, extra),
            edit ? h("button", { class: "icon-btn prop-edit", type: "button", title: `Edit ${label.toLowerCase()}`, "aria-label": `Edit ${label.toLowerCase()}`, disabled, onclick: (event) => edit(event.currentTarget) }, icon("pencil", { size: 13 })) : null,
        ),
    );
}

function propsSection(ctx) {
    const update = (patch) => attempt(() => patchItem(ctx.iid, patch));
    // While someone types into a date field the section must not repaint underneath them.
    let typingDate = false;
    let reg = null;

    function assigneePicker(anchor, d) {
        const members = state.meta?.members ?? [];
        const known = new Set(members.map((member) => member.username));
        const people = [...d.assignees.filter((user) => !known.has(user.username)), ...members];
        togglePicker(anchor, {
            title: "Assignees",
            multi: true,
            searchable: people.length > 6,
            searchPlaceholder: "Filter people…",
            selected: d.assignees.map((user) => user.username),
            options: people.map(personOption),
            emptyText: "No project members found.",
            footer: state.meta?.truncated ? "Only the first project members are listed." : "",
            onSelect: (usernames) => update({ assignees: usernames }),
        });
    }

    function labelPicker(anchor, d) {
        const before = d.labels.map((label) => label.title);
        togglePicker(anchor, {
            title: "Labels",
            multi: true,
            searchable: true,
            searchPlaceholder: "Filter labels…",
            selected: before,
            options: (state.meta?.labels ?? []).map(labelOption),
            exclusiveGroup: labelScopeOf(),
            emptyText: "This project has no labels yet.",
            footer: state.meta?.truncated ? "Only the first labels are listed." : "",
            onSelect: (titles) => update({ addLabels: titles.filter((title) => !before.includes(title)), removeLabels: before.filter((title) => !titles.includes(title)) }),
        });
    }

    function milestonePicker(anchor, d) {
        const listed = state.meta?.milestones ?? [];
        const current = d.milestone && !listed.some((milestone) => milestone.title === d.milestone.title) ? [d.milestone] : [];
        togglePicker(anchor, {
            title: "Milestone",
            selected: d.milestone?.title ?? "",
            options: [{ value: "", label: "No milestone" }, ...[...current, ...listed].map(milestoneOption)],
            onSelect: (value) => update({ milestone: value }),
        });
    }

    function parentPicker(anchor, d) {
        const allowed = typeRules(d.type?.name).parents;
        const nobody = allowed !== null && allowed.length === 0;
        togglePicker(anchor, {
            title: "Parent",
            width: 340,
            searchPlaceholder: "Search by title or #number",
            selected: d.parent ? d.parent.iid : "",
            options: async (query) => {
                const rows = nobody ? [] : (await searchItems(query, allowed ?? undefined)).filter((item) => item.iid !== d.iid).map(itemOption);
                return d.parent && !query ? [{ value: "", label: "Remove parent" }, ...rows] : rows;
            },
            onSelect: (value) => update({ parent: value === "" ? "" : Number(value) }),
        });
    }

    function dateRow(d, key, label) {
        const can = d.permissions.update;
        const saved = d[key] ?? "";
        const input = h("input", { class: "date-input", type: "date", "aria-label": label, disabled: !can });
        input.value = saved;
        if (key === "startDate" && d.dueDate) input.max = d.dueDate;
        if (key === "dueDate" && d.startDate) input.min = d.startDate;

        let typing = false;
        let saving = false;
        const commit = async (value) => {
            if (saving) return;
            saving = true;
            input.setAttribute("aria-busy", "true");
            const done = await update({ [key]: value });
            saving = false;
            input.removeAttribute("aria-busy");
            if (!done) input.value = saved;
        };
        // Browsers fire "change" for every intermediate value while a date is typed (1, 12, 12/2, ...), so a typed edit
        // is saved once it is finished (Enter, or leaving the field); a calendar pick arrives as one lone change.
        const settle = () => {
            typing = typingDate = false;
            setTimeout(() => reg.update(ctx.detail), 0);
            // A half-typed date reads as "" (no value), so it has to be told apart from an untouched empty field.
            const half = input.validity.badInput;
            if (saving || !input.isConnected || (input.value === saved && !half)) return;
            const problem =
                half || !/^[1-9]\d{3}-\d\d-\d\d$/.test(input.value)
                    ? "Enter a complete date with a four-digit year, or use the clear button to remove it."
                    : input.validity.rangeUnderflow
                      ? "The due date cannot be before the start date."
                      : input.validity.rangeOverflow
                        ? "The start date cannot be after the due date."
                        : "";
            if (problem) {
                input.value = saved;
                if (half) reg.repaint(ctx.detail);
                notifyError(new Error(problem));
            } else commit(input.value);
        };
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") settle();
            else if (event.key === "Escape" && typing) {
                event.stopPropagation();
                input.value = saved;
                typing = typingDate = false;
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && /^(\d|Backspace|Delete|ArrowUp|ArrowDown)$/.test(event.key)) typing = typingDate = true;
        });
        input.addEventListener("pointerdown", () => (typing = false));
        input.addEventListener("change", () => !typing && settle());
        // Focus moving between the segments of one date field is not leaving it, so only a real blur settles.
        input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && settle(), 0));

        const status = key === "dueDate" ? dueStatus(d.dueDate, d.state) : "";
        const clear = can && d[key] ? h("button", { class: "icon-btn", type: "button", title: `Clear ${label.toLowerCase()}`, "aria-label": `Clear ${label.toLowerCase()}`, dataset: { focusNext: label }, onclick: () => commit("") }, icon("x", { size: 12 })) : null;
        return prop(key === "dueDate" ? "clock" : "calendar", label, [input, clear, status ? h("span", { class: `meta-chip due ${status}` }, status === "overdue" ? "Overdue" : "Due soon") : null]);
    }

    reg = region(h("div", { class: "d-props" }), {
        frozen: () => typingDate,
        signature: (d) => [d.assignees.map((user) => user.username), d.labels.map((label) => [label.title, label.color]), d.milestone, d.parent, d.startDate, d.dueDate, d.confidential, d.permissions, d.supports, d.state, state.meta?.user?.username, typeRules(d.type?.name).parents],
        paint(node, d) {
            const can = d.permissions.update;
            const me = state.meta?.user;
            const rows = [];
            if (d.supports.assignees) {
                const mine = me && !d.assignees.some((user) => user.username === me.username);
                rows.push(
                    prop("person", "Assignees", d.assignees.length ? d.assignees.map((user) => h("span", { class: "person" }, avatar(user, 18), h("span", {}, user.name))) : muted("No one"), {
                        edit: can ? (anchor) => assigneePicker(anchor, d) : null,
                        extra: can && mine ? h("button", { class: "link-btn", type: "button", dataset: { focusNext: "Edit assignees" }, onclick: () => update({ assignees: [...d.assignees.map((user) => user.username), me.username] }) }, "Assign myself") : null,
                    }),
                );
            }
            if (d.supports.labels) rows.push(prop("tag", "Labels", d.labels.length ? h("span", { class: "chips" }, d.labels.map(labelChip)) : muted("None"), { edit: can ? (anchor) => labelPicker(anchor, d) : null }));
            if (d.supports.milestone) {
                const m = d.milestone;
                rows.push(prop("milestone", "Milestone", m ? [m.title, m.dueDate ? h("span", { class: "muted" }, ` · due ${dayLabel(m.dueDate)}`) : null] : muted("None"), { edit: can ? (anchor) => milestonePicker(anchor, d) : null }));
            }
            const parents = typeRules(d.type?.name).parents;
            if (d.supports.hierarchy && (d.parent || parents === null || parents.length > 0)) rows.push(prop("up", "Parent", d.parent ? itemButton(d.parent, ctx) : muted("None"), { edit: d.permissions.setParent ? (anchor) => parentPicker(anchor, d) : null }));
            if (d.supports.dates) rows.push(dateRow(d, "startDate", "Start date"), dateRow(d, "dueDate", "Due date"));
            const box = h("input", { type: "checkbox", disabled: !can, "aria-label": "Confidential" });
            box.checked = d.confidential;
            let saving = false;
            box.addEventListener("change", async () => {
                if (saving) {
                    box.checked = !box.checked;
                    return;
                }
                saving = true;
                box.setAttribute("aria-busy", "true");
                const done = await update({ confidential: box.checked });
                saving = false;
                box.removeAttribute("aria-busy");
                if (!done) box.checked = d.confidential;
            });
            rows.push(prop("lock", "Confidential", h("label", { class: "check" }, box, h("span", {}, "Only project members can see this"))));
            setChildren(node, ...rows);
        },
    });
    return reg;
}

// ---- description ----------------------------------------------------------------------------------------------------
function descriptionSection(ctx) {
    let editing = false;
    const el = h("section", { class: "d-section d-desc", "aria-label": "Description" });
    const preview = (text) => renderMarkdown(text, { base: baseUrl(), onRef: ctx.go });
    const reg = region(el, {
        frozen: () => editing,
        signature: (d) => [d.description, d.edited, d.lastEditedAt, d.lastEditedBy, d.tasks, d.permissions.update, baseUrl()],
        paint(node, d) {
            const can = d.permissions.update;
            setChildren(node,
                h(
                    "div",
                    { class: "d-section-head" },
                    h("h3", {}, "Description"),
                    d.tasks?.total ? h("span", { class: "d-count", title: "Checklist items completed" }, `${d.tasks.done}/${d.tasks.total} done`) : null,
                    h("span", { class: "tb-spacer" }),
                    can ? h("button", { class: "btn ghost small", type: "button", dataset: { focusKey: "edit-description" }, onclick: start }, icon("pencil", { size: 12 }), d.description.trim() ? "Edit" : "Add") : null,
                ),
                d.description.trim() ? renderMarkdown(d.description, { base: baseUrl(), onRef: ctx.go }) : h("p", { class: "d-empty" }, "No description yet."),
                d.edited ? h("p", { class: "d-foot", title: fullTime(d.lastEditedAt) }, `Edited ${relTime(d.lastEditedAt)}${d.lastEditedBy ? ` by ${d.lastEditedBy}` : ""}`) : null,
            );
        },
    });

    function stop() {
        editing = false;
        reg.repaint(ctx.detail);
        returnFocus(el, el.querySelector('[data-focus-key="edit-description"]'));
    }

    function start() {
        const before = ctx.detail.description;
        editing = true;
        const editor = markdownEditor({
            value: before,
            label: "Description",
            placeholder: "Describe the work item…",
            rows: 8,
            submitLabel: "Save",
            allowEmpty: true,
            renderPreview: preview,
            onCancel: stop,
            onSubmit: async (text) => {
                if (text !== before) await patchItem(ctx.iid, { description: text });
                stop();
            },
        });
        setChildren(el, h("div", { class: "d-section-head" }, h("h3", {}, "Description")), editor.el);
        editor.focus({ end: true });
    }
    return reg;
}

// ---- child items ----------------------------------------------------------------------------------------------------
function childrenSection(ctx) {
    let adding = false;
    const el = h("section", { class: "d-section d-children", "aria-label": "Child items" });
    const inner = h("div", {});
    const input = h("input", { class: "add-input", type: "text", maxlength: 255, placeholder: "New task title. Enter adds it, Esc closes.", "aria-label": "New child task title", autocomplete: "off" });
    const form = h("div", { class: "add-row", hidden: true }, input, h("button", { class: "btn small", type: "button", onclick: () => submit() }, "Add"));
    el.append(inner, form);

    async function submit() {
        const title = input.value.trim();
        if (!title || input.readOnly) return;
        input.readOnly = true;
        const created = await attempt(() => addChild(ctx.iid, title));
        input.readOnly = false;
        if (created) input.value = "";
        input.focus();
    }
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            submit();
        } else if (event.key === "Escape") {
            event.stopPropagation();
            toggle(false);
        }
    });

    const reg = region(inner, {
        signature: (d) => [d.children, d.permissions, d.supports.hierarchy, d.type?.name, typeRules(d.type?.name).children, adding],
        paint(node, d) {
            const done = d.children.filter((child) => child.state === "closed").length;
            const can = canAddTask(d);
            const refresh = () => loadDetail(ctx.iid, { quiet: true });
            setChildren(node,
                h(
                    "div",
                    { class: "d-section-head" },
                    h("h3", {}, "Child items"),
                    d.children.length ? h("span", { class: "d-count" }, `${done}/${d.children.length} closed`) : null,
                    h("span", { class: "tb-spacer" }),
                    can ? h("button", { class: "btn ghost small", type: "button", "aria-expanded": String(adding), dataset: { focusKey: "add-task" }, onclick: () => toggle(!adding) }, icon("plus", { size: 12 }), "Add task") : null,
                ),
                d.children.length ? h("div", { class: "progress", role: "img", "aria-label": `${done} of ${d.children.length} child items closed` }, h("span", { style: { width: `${Math.round((done / d.children.length) * 100)}%` } })) : null,
                d.children.length
                    ? h(
                          "ul",
                          { class: "d-list" },
                          d.children.map((child) => {
                              const closed = child.state === "closed";
                              return h(
                                  "li",
                                  { class: `d-item${closed ? " closed" : ""}` },
                                  h("button", { class: "icon-btn child-state", type: "button", disabled: !d.permissions.update, title: closed ? "Reopen" : "Close", "aria-label": `${closed ? "Reopen" : "Close"} #${child.iid}`, dataset: { focusKey: `child-state-${child.iid}` }, onclick: async () => {
                                      await attempt(() => patchItem(child.iid, { state: closed ? "open" : "closed" }));
                                      refresh();
                                  } }, stateIcon(child.state, { size: 15 })),
                                  h("span", { class: "d-item-type", title: child.type ?? "" }, typeIcon(child.type, { size: 13 })),
                                  h("button", { class: "item-link", type: "button", title: `Open #${child.iid}`, onclick: () => ctx.go(child.iid) }, h("span", { class: "item-title" }, child.title), h("span", { class: "item-id" }, `#${child.iid}`)),
                                  d.permissions.update ? h("button", { class: "icon-btn row-action", type: "button", title: "Remove from this parent", "aria-label": `Remove #${child.iid} from this parent`, dataset: { focusNext: "add-task" }, onclick: async () => {
                                      await attempt(() => patchItem(child.iid, { parent: "" }));
                                      refresh();
                                  } }, icon("x", { size: 12 })) : null,
                              );
                          }),
                      )
                    : h("p", { class: "d-empty" }, "No child items."),
            );
        },
    });

    function toggle(on) {
        const hadFocus = form.contains(document.activeElement);
        adding = on;
        form.hidden = !on;
        reg.repaint(ctx.detail);
        if (on) input.focus();
        else if (hadFocus) inner.querySelector('[data-focus-key="add-task"]')?.focus({ preventScroll: true });
    }

    return {
        el,
        update(detail) {
            const show = detail.supports.hierarchy && (detail.children.length > 0 || canAddTask(detail));
            el.hidden = !show;
            if (show) reg.update(detail);
        },
    };
}

// ---- linked items ---------------------------------------------------------------------------------------------------
function linksSection(ctx) {
    const el = h("section", { class: "d-section d-links", "aria-label": "Linked items" });

    function chooseTarget(anchor, d, type) {
        const taken = new Set([d.iid, ...d.linked.map((link) => link.item.iid)]);
        openPicker(anchor, {
            title: LINK_PROMPT[type],
            width: 340,
            searchPlaceholder: "Search by title or #number",
            always: true,
            options: async (query) => (await searchItems(query)).filter((item) => !taken.has(item.iid)).map(itemOption),
            onSelect: (iid) => attempt(() => linkItems(ctx.iid, Number(iid), type)),
        });
    }

    function chooseType(anchor, d) {
        togglePicker(anchor, {
            title: "Link this item",
            selected: "",
            options: [
                { value: "related", label: "Relates to", hint: "related work" },
                { value: "blocks", label: "Blocks", hint: "this must finish first" },
                { value: "blocked_by", label: "Is blocked by", hint: "waiting on another item" },
            ],
            onSelect: (type) => chooseTarget(anchor, d, type),
        });
    }

    const reg = region(el, {
        signature: (d) => [d.linked, d.permissions.link],
        paint(node, d) {
            const can = d.permissions.link;
            const groups = LINK_GROUPS.map(([type, label]) => [label, d.linked.filter((link) => link.type === type)]).filter(([, links]) => links.length);
            setChildren(node,
                h(
                    "div",
                    { class: "d-section-head" },
                    h("h3", {}, "Linked items"),
                    d.linked.length ? h("span", { class: "d-count" }, String(d.linked.length)) : null,
                    h("span", { class: "tb-spacer" }),
                    can ? h("button", { class: "btn ghost small", type: "button", dataset: { focusKey: "link-item" }, onclick: (event) => chooseType(event.currentTarget, ctx.detail) }, icon("link", { size: 12 }), "Link item") : null,
                ),
                groups.length
                    ? groups.map(([label, links]) =>
                          h(
                              "div",
                              { class: "d-group" },
                              h("div", { class: "d-group-name" }, label),
                              h(
                                  "ul",
                                  { class: "d-list" },
                                  links.map((link) =>
                                      h(
                                          "li",
                                          { class: `d-item${link.item.state === "closed" ? " closed" : ""}` },
                                          itemButton(link.item, ctx),
                                          can ? h("button", { class: "icon-btn row-action", type: "button", title: "Remove link", "aria-label": `Remove link to #${link.item.iid}`, dataset: { focusNext: "link-item" }, onclick: () => attempt(() => unlinkItems(ctx.iid, link.item.iid)) }, icon("x", { size: 12 })) : null,
                                      ),
                                  ),
                              ),
                          ),
                      )
                    : h("p", { class: "d-empty" }, "Nothing linked yet."),
            );
        },
    });
    return {
        el,
        update(detail) {
            el.hidden = !detail.supports.links;
            if (!el.hidden) reg.update(detail);
        },
    };
}

// ---- comments -------------------------------------------------------------------------------------------------------
function noteView(note, ctx, { reply = false } = {}) {
    return h(
        "article",
        { class: `note${reply ? " reply" : ""}${note.internal ? " internal" : ""}` },
        h(
            "header",
            { class: "note-head" },
            note.author ? avatar(note.author, 22) : null,
            h("strong", {}, note.author?.name ?? "Unknown user"),
            note.author ? h("span", { class: "muted" }, `@${note.author.username}`) : null,
            h("span", { class: "muted" }, "·"),
            time(note.createdAt),
            note.internal ? h("span", { class: "pill internal", title: "Only visible to project members" }, icon("lock", { size: 11 }), "Internal") : null,
        ),
        renderMarkdown(note.body, { base: baseUrl(), onRef: ctx.go }),
    );
}

function commentsSection(ctx) {
    const el = h("section", { class: "d-section d-comments", "aria-label": "Comments" });
    const head = h("div", { class: "d-section-head" });
    const notes = h("div", { class: "notes" });
    const notice = h("p", { class: "d-empty", hidden: true });
    const editor = markdownEditor({
        label: "Comment",
        placeholder: "Write a comment…",
        rows: 3,
        submitLabel: "Comment",
        renderPreview: (text) => renderMarkdown(text, { base: baseUrl(), onRef: ctx.go }),
        onSubmit: async (text) => {
            await addComment(ctx.iid, text);
            editor.value = "";
        },
    });
    const composer = h("div", { class: "composer" }, editor.el);
    el.append(head, notes, notice, composer);

    const reg = region(notes, {
        signature: (d) => d.discussions.map((discussion) => [discussion.id, discussion.notes.map((note) => [note.id, note.updatedAt])]),
        paint(node, d) {
            setChildren(node, ...(d.discussions.length ? d.discussions.map((discussion) => h("div", { class: "thread" }, discussion.notes.map((note, index) => noteView(note, ctx, { reply: index > 0 })))) : [h("p", { class: "d-empty" }, "No comments yet.")]));
        },
    });

    return {
        el,
        update(detail) {
            el.hidden = !detail.supports.notes;
            if (el.hidden) return;
            const count = detail.discussions.reduce((total, discussion) => total + discussion.notes.length, 0);
            setChildren(head, h("h3", {}, "Comments"), count ? h("span", { class: "d-count" }, String(count)) : null);
            reg.update(detail);
            const blocked = detail.locked ? "The conversation is locked." : !detail.permissions.comment ? "You do not have permission to comment here." : "";
            notice.textContent = blocked;
            notice.hidden = !blocked;
            composer.hidden = Boolean(blocked);
            editor.setDisabled(Boolean(blocked));
        },
    };
}

// ---- drawer ---------------------------------------------------------------------------------------------------------
export function mountDetail(root, { onClose }) {
    let shell = null;
    let trail = [];
    let expected = null;
    root.tabIndex = -1;

    function go(iid) {
        const current = state.view.selected;
        if (iid === current) return;
        if (current !== null) trail = [...trail.slice(-(TRAIL_MAX - 1)), current];
        expected = iid;
        select(iid);
    }

    function back() {
        const iid = trail.pop();
        if (iid === undefined) return;
        expected = iid;
        select(iid);
    }

    function buildShell(iid) {
        const backBtn = h("button", { class: "icon-btn", type: "button", title: "Back", "aria-label": "Back to the previous work item", hidden: true, onclick: back }, icon("back", { size: 15 }));
        const kindIcon = h("span", { class: "d-kind-icon" });
        const kindName = h("span", { class: "d-kind-name" }, "Work item");
        const link = h("a", { class: "icon-btn", target: "_blank", rel: "noopener noreferrer", title: "Open in GitLab", "aria-label": "Open in GitLab", hidden: true }, icon("external", { size: 15 }));
        const close = h("button", { class: "icon-btn", type: "button", title: "Close panel (Esc)", "aria-label": "Close details", onclick: () => onClose() }, icon("x", { size: 15 }));
        const body = h("div", { class: "d-body" });
        setChildren(root, h("header", { class: "d-head" }, backBtn, h("span", { class: "d-kind" }, kindIcon, kindName, h("span", { class: "d-kind-id" }, `#${iid}`)), h("span", { class: "tb-spacer" }), link, close), body);
        return { iid, backBtn, kindIcon, kindName, link, body, mode: "", content: null, errorShown: null };
    }

    function paintHead(detail) {
        setChildren(shell.kindIcon, typeIcon(detail.type?.name, { size: 15 }));
        shell.kindName.textContent = detail.type?.name ?? "Work item";
        const url = detail.webUrl;
        if (url && /^https?:\/\//i.test(url)) {
            shell.link.setAttribute("href", url);
            shell.link.hidden = false;
        } else shell.link.hidden = true;
    }

    function buildContent(iid, first) {
        const ctx = { iid, detail: first, go };
        const parts = [titleSection(ctx), statusSection(ctx), propsSection(ctx), descriptionSection(ctx), childrenSection(ctx), linksSection(ctx), commentsSection(ctx)];
        return {
            el: h("div", { class: "d-content" }, parts.map((part) => part.el)),
            update(detail) {
                ctx.detail = detail;
                for (const part of parts) part.update(detail);
            },
        };
    }

    function render() {
        const iid = state.view.selected;
        if (iid === null) {
            root.hidden = true;
            if (shell) root.replaceChildren();
            shell = null;
            trail = [];
            expected = null;
            return;
        }
        root.hidden = false;
        if (shell?.iid !== iid) {
            const navigated = iid === expected;
            if (!navigated) trail = [];
            expected = null;
            shell = buildShell(iid);
            if (navigated) queueMicrotask(() => root.focus({ preventScroll: true }));
        }
        shell.backBtn.hidden = trail.length === 0;
        const detail = state.detail?.iid === iid ? state.detail : null;

        if (!detail && state.detailStatus === "error") {
            if (shell.mode !== "error" || shell.errorShown !== state.detailError) {
                setChildren(shell.body, errorBox(state.detailError, () => loadDetail(iid), `Could not load #${iid}`));
                shell.mode = "error";
                shell.errorShown = state.detailError;
                shell.content = null;
            }
        } else if (!detail) {
            if (shell.mode !== "loading") {
                setChildren(shell.body,
                    h("div", { class: "d-skeleton", "aria-hidden": "true" }, h("span", { class: "sk sk-line", style: { width: "72%", height: "18px" } }), h("span", { class: "sk sk-line", style: { width: "38%" } }), h("span", { class: "sk sk-line" }), h("span", { class: "sk sk-line" }), h("span", { class: "sk sk-line short" })),
                );
                shell.mode = "loading";
                shell.content = null;
            }
        } else {
            if (shell.mode !== "content") {
                shell.content = buildContent(iid, detail);
                setChildren(shell.body, shell.content.el);
                shell.mode = "content";
            }
            paintHead(detail);
            shell.content.update(detail);
        }
    }

    return { render };
}

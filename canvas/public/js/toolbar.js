// Toolbar: project switcher, counts, view toggle and all filter controls. Built once; sync() mirrors the state.
import { avatar, dayLabel, debounce, h, icon, labelChip, setChildren, toast, typeIcon } from "./dom.js";
import { togglePicker } from "./pickers.js";
import { filtersActive, notifyError, refreshAll, resetFilters, state, switchProject, updateView } from "./state.js";

const SORT_OPTIONS = [
    ["updated_desc", "Recently updated"],
    ["updated_asc", "Least recently updated"],
    ["created_desc", "Newest first"],
    ["created_asc", "Oldest first"],
    ["title_asc", "Title A to Z"],
    ["title_desc", "Title Z to A"],
    ["due_asc", "Due soonest"],
    ["due_desc", "Due latest"],
];
const STATE_OPTIONS = [["open", "Open"], ["closed", "Closed"], ["all", "All"]];

export const groupLabel = (groupBy) => (groupBy === "state" ? "State" : groupBy === "assignee" ? "Assignee" : groupBy === "milestone" ? "Milestone" : `Label: ${String(groupBy).slice(6)}`);

const withIcon = (leading, text, hint) => () => h("span", { class: "pick-label with-icon" }, leading, h("span", { class: "pick-text" }, text), hint ? h("span", { class: "pick-hint" }, hint) : null);

export const personOption = (user) => ({
    value: user.username,
    label: user.name || user.username,
    keywords: `${user.username} ${user.name ?? ""}`,
    render: withIcon(avatar(user, 18), user.name || user.username, `@${user.username}`),
});

export const labelOption = (label) => ({ value: label.title, label: label.title, keywords: label.description ?? "", render: () => h("span", { class: "pick-label" }, labelChip(label)) });

export const milestoneOption = (milestone) => ({
    value: milestone.title,
    label: milestone.title,
    hint: milestone.dueDate ? `due ${dayLabel(milestone.dueDate)}` : milestone.state === "closed" ? "closed" : "",
});

export const typeOption = (type) => ({ value: type.name, label: type.name, render: withIcon(typeIcon(type.name, { size: 14 }), type.name) });

function segmented(label, items, onPick, { withIcons = false } = {}) {
    const buttons = items.map(([value, text, iconName]) =>
        h("button", { type: "button", class: "seg-btn", dataset: { value }, "aria-pressed": "false", onclick: () => onPick(value) }, withIcons && iconName ? icon(iconName, { size: 14 }) : null, h("span", {}, text)),
    );
    return {
        el: h("div", { class: "seg", role: "group", "aria-label": label }, buttons),
        set(value, disabled = false) {
            for (const button of buttons) {
                const on = button.dataset.value === value;
                button.classList.toggle("on", on);
                button.setAttribute("aria-pressed", String(on));
                button.disabled = disabled;
            }
        },
    };
}

export function filterButton(iconName, label, open) {
    const value = h("span", { class: "fvalue" });
    const el = h("button", { class: "fbtn", type: "button", onclick: () => open(el) }, icon(iconName, { size: 14 }), h("span", { class: "flabel" }, label), value, icon("chevron", { size: 12, cls: "fchev" }));
    return {
        el,
        set(text, { active = false, disabled = false, title = "" } = {}) {
            value.textContent = text ?? "";
            el.classList.toggle("active", active);
            el.disabled = disabled;
            el.title = title;
        },
    };
}

export function mountToolbar(root, { onCreate }) {
    const projectName = h("span", { class: "project-name" });
    const projectBtn = h("button", { class: "project-btn", type: "button", onclick: () => openProjectPicker(projectBtn) }, projectName, icon("chevron", { size: 12 }));
    const count = h("span", { class: "tb-count", "aria-live": "polite" });
    const saving = h("span", { class: "tb-saving", hidden: true }, "Saving…");
    const live = h("span", { class: "live-dot", role: "img" });
    const refreshIcon = icon("refresh", { size: 15 });
    const refreshBtn = h("button", { class: "icon-btn", type: "button", title: "Refresh", "aria-label": "Refresh", onclick: () => refreshAll({ meta: true }) }, refreshIcon);
    const modes = segmented("View", [["list", "List", "list"], ["board", "Board", "board"]], (mode) => updateView({ mode }), { withIcons: true });
    const newBtn = h("button", { class: "btn primary", type: "button", title: "New work item (N)", onclick: () => onCreate() }, icon("plus", { size: 14 }), h("span", {}, "New"));

    const searchInput = h("input", { class: "search-input", type: "text", placeholder: "Search titles and descriptions, or type #12", "aria-label": "Search work items", autocomplete: "off", spellcheck: "false" });
    const applySearch = debounce(() => updateView({ filters: { search: searchInput.value.trim() } }), 320);
    searchInput.addEventListener("input", applySearch);
    searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            applySearch.cancel();
            updateView({ filters: { search: searchInput.value.trim() } });
        } else if (event.key === "Escape" && searchInput.value) {
            event.stopPropagation();
            searchInput.value = "";
            applySearch.cancel();
            updateView({ filters: { search: "" } });
        }
    });
    const search = h("label", { class: "search" }, icon("search", { size: 14 }), searchInput);

    const states = segmented("State", STATE_OPTIONS, (value) => updateView({ filters: { state: value } }));
    const type = filterButton("task", "Type", (anchor) => typePicker(anchor));
    const assignee = filterButton("person", "Assignee", (anchor) => assigneePicker(anchor));
    const label = filterButton("tag", "Label", (anchor) => labelPicker(anchor));
    const milestone = filterButton("milestone", "Milestone", (anchor) => milestonePicker(anchor));
    const sort = filterButton("sort", "Sort", (anchor) => sortPicker(anchor));
    const group = filterButton("group", "Group", (anchor) => groupPicker(anchor));
    const clearBtn = h("button", { class: "link-btn", type: "button", onclick: () => resetFilters() }, "Clear filters");

    setChildren(root,
        h("div", { class: "tb-row tb-top" }, projectBtn, count, h("span", { class: "tb-spacer" }), saving, live, refreshBtn, modes.el, newBtn),
        h("div", { class: "tb-row tb-filters" }, search, states.el, type.el, assignee.el, label.el, milestone.el, sort.el, group.el, clearBtn),
    );

    // ---- pickers (built at click time so they always see the latest metadata) -----------------------------------------
    function openProjectPicker(anchor) {
        const current = state.meta?.project?.fullPath ?? state.project?.path ?? "";
        togglePicker(anchor, {
            title: "Project",
            width: 300,
            searchPlaceholder: "group/project or project URL",
            selected: current,
            options: (query) =>
                query
                    ? [{ value: query, label: `Open ${query}` }]
                    : [...(current ? [{ value: current, label: current, hint: "current" }] : []), { value: "", label: "Type group/project or paste a project URL", disabled: true, muted: true }],
            onSelect: async (value) => {
                try {
                    await switchProject(value);
                    toast(`Showing ${state.meta?.project?.fullPath ?? value}`);
                } catch (error) {
                    notifyError(error);
                }
            },
        });
    }

    function typePicker(anchor) {
        togglePicker(anchor, {
            title: "Type",
            selected: state.view.filters.type,
            options: [{ value: "", label: "Any type" }, ...(state.meta?.types ?? []).map(typeOption)],
            onSelect: (value) => updateView({ filters: { type: value } }),
        });
    }

    function assigneePicker(anchor) {
        const me = state.meta?.user;
        togglePicker(anchor, {
            title: "Assignee",
            searchable: (state.meta?.members?.length ?? 0) > 6,
            searchPlaceholder: "Filter people…",
            selected: state.view.filters.assignee,
            footer: state.meta?.truncated ? "Only the first project members are listed." : "",
            options: [
                { value: "", label: "Any assignee" },
                ...(me ? [{ value: "me", label: "Assigned to me", hint: `@${me.username}` }] : []),
                { value: "none", label: "Unassigned" },
                { value: "any", label: "Has an assignee" },
                ...(state.meta?.members ?? []).map((user) => ({ ...personOption(user), group: "People" })),
            ],
            onSelect: (value) => updateView({ filters: { assignee: value } }),
        });
    }

    function labelPicker(anchor) {
        togglePicker(anchor, {
            title: "Labels",
            multi: true,
            immediate: true,
            searchable: true,
            searchPlaceholder: "Filter labels…",
            selected: state.view.filters.label,
            emptyText: "This project has no labels yet.",
            footer: state.meta?.truncated ? "Only the first labels are listed." : "",
            options: (state.meta?.labels ?? []).map(labelOption),
            onSelect: (labels) => updateView({ filters: { label: labels } }),
        });
    }

    function milestonePicker(anchor) {
        togglePicker(anchor, {
            title: "Milestone",
            selected: state.view.filters.milestone,
            options: [
                { value: "", label: "Any milestone" },
                { value: "none", label: "No milestone" },
                { value: "any", label: "Has a milestone" },
                { value: "started", label: "Started" },
                { value: "upcoming", label: "Upcoming" },
                ...(state.meta?.milestones ?? []).map((m) => ({ ...milestoneOption(m), group: "Milestones" })),
            ],
            onSelect: (value) => updateView({ filters: { milestone: value } }),
        });
    }

    function sortPicker(anchor) {
        togglePicker(anchor, {
            title: "Sort by",
            selected: state.view.filters.sort,
            options: SORT_OPTIONS.map(([value, text]) => ({ value, label: text })),
            onSelect: (value) => updateView({ filters: { sort: value } }),
        });
    }

    function groupPicker(anchor) {
        const scopes = state.meta?.scopes ?? [];
        togglePicker(anchor, {
            title: "Group board by",
            selected: state.view.groupBy,
            options: [
                { value: "state", label: "State" },
                { value: "assignee", label: "Assignee" },
                { value: "milestone", label: "Milestone" },
                ...scopes.map((scope) => ({ value: `scope:${scope}`, label: `Label: ${scope}`, hint: "scoped labels" })),
            ],
            onSelect: (value) => updateView({ groupBy: value }),
        });
    }

    // ---- state -> controls -------------------------------------------------------------------------------------------
    const countText = () => {
        if (state.loadError && !state.items.length) return "";
        if (state.loading && !state.items.length) return "Loading…";
        const { filters, mode, groupBy } = state.view;
        const kind = mode === "board" && groupBy === "state" ? "" : filters.state === "all" ? "" : `${filters.state} `;
        const shown = state.items.length;
        if (state.hasNextPage) return `${shown} of ${state.total} ${kind}items`;
        return `${shown} ${kind}${shown === 1 ? "item" : "items"}`;
    };

    function sync() {
        const { view, meta } = state;
        const f = view.filters;
        const full = meta?.project?.fullPath ?? state.project?.path ?? "Choose project";
        projectName.textContent = full;
        projectBtn.title = `${full}${meta?.host ? ` on ${meta.host}` : ""} (click to switch project)`;
        count.textContent = countText();
        saving.hidden = state.saving === 0;
        refreshIcon.classList.toggle("spin", state.syncing);
        live.dataset.status = state.live;
        live.title = state.live === "live" ? "Live updates connected" : state.live === "reconnecting" ? "Reconnecting to live updates…" : state.live === "closed" ? "Live updates are off. Use refresh." : "Connecting…";
        live.setAttribute("aria-label", live.title);
        modes.set(view.mode);
        const byState = view.mode === "board" && view.groupBy === "state";
        states.set(byState ? "all" : f.state, byState);
        states.el.title = byState ? "The board is grouped by state, so it shows open and closed items" : "";
        if (document.activeElement !== searchInput && searchInput.value !== f.search) searchInput.value = f.search;

        type.set(f.type, { active: Boolean(f.type) });
        const person = f.assignee === "me" ? "Me" : f.assignee === "none" ? "Unassigned" : f.assignee === "any" ? "Has assignee" : f.assignee ? `@${f.assignee}` : "";
        assignee.set(person, { active: Boolean(f.assignee) });
        const noLabels = (meta?.labels?.length ?? 0) === 0 && f.label.length === 0;
        label.set(f.label.length > 1 ? `${f.label.length} selected` : (f.label[0] ?? ""), { active: f.label.length > 0, disabled: noLabels, title: noLabels ? "This project has no labels yet" : "" });
        const noMilestones = (meta?.milestones?.length ?? 0) === 0 && !f.milestone;
        const milestoneText = { none: "None", any: "Has milestone", started: "Started", upcoming: "Upcoming" }[f.milestone] ?? f.milestone;
        milestone.set(milestoneText, { active: Boolean(f.milestone), disabled: noMilestones, title: noMilestones ? "This project has no milestones yet" : "" });
        sort.set(SORT_OPTIONS.find(([value]) => value === f.sort)?.[1] ?? "", { active: f.sort !== "updated_desc" });
        group.el.hidden = view.mode !== "board";
        group.set(groupLabel(view.groupBy), { active: view.groupBy !== "state" });
        clearBtn.hidden = !filtersActive();
    }

    sync();
    return { sync, focusSearch: () => searchInput.focus() };
}

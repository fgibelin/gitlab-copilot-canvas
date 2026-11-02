// Board view: columns by state, assignee, milestone or a scoped-label scope. Cards move between columns by drag and
// drop, or with the "Move to…" menu (also the M key), which is the keyboard-accessible path.
import { avatar, avatarStack, h, icon, labelChip, setChildren, stateIcon, typeIcon } from "./dom.js";
import { dueBadge, errorBox, labelChips, loadMoreItems, milestoneBadge, retryLoad, stateBox } from "./parts.js";
import { togglePicker } from "./pickers.js";
import { filtersActive, notifyError, patchItem, resetFilters, select, state } from "./state.js";

const byName = (a, b) => String(a.name || a.username || a.title).localeCompare(String(b.name || b.username || b.title));

function buildColumns(groupBy, items, meta) {
    if (groupBy === "assignee") {
        const people = new Map((meta?.members ?? []).map((user) => [user.username, user]));
        for (const item of items) for (const user of item.assignees) if (!people.has(user.username)) people.set(user.username, user);
        let users = [...people.values()].sort(byName);
        if ((meta?.members?.length ?? 0) > 10) users = users.filter((user) => items.some((item) => item.assignees.some((a) => a.username === user.username)));
        return [
            { key: "unassigned", title: "Unassigned", lead: () => icon("person", { size: 14 }), match: (item) => item.assignees.length === 0, patch: () => ({ assignees: [] }), preset: {} },
            ...users.map((user) => ({
                key: `u:${user.username}`,
                title: user.name || user.username,
                lead: () => avatar(user, 18),
                match: (item) => item.assignees.some((a) => a.username === user.username),
                patch: (item, from) => {
                    const left = item.assignees.map((a) => a.username).filter((name) => `u:${name}` !== from);
                    return { assignees: [...new Set([...left, user.username])] };
                },
                preset: { assignees: [user.username] },
            })),
        ];
    }
    if (groupBy === "milestone") {
        const known = new Map((meta?.milestones ?? []).map((m) => [m.title, m]));
        for (const item of items) if (item.milestone && !known.has(item.milestone.title)) known.set(item.milestone.title, item.milestone);
        return [
            { key: "none", title: "No milestone", lead: () => icon("milestone", { size: 14 }), match: (item) => !item.milestone, patch: () => ({ milestone: "" }), preset: {} },
            ...[...known.values()].map((m) => ({ key: `m:${m.title}`, title: m.title, lead: () => icon("milestone", { size: 14 }), match: (item) => item.milestone?.title === m.title, patch: () => ({ milestone: m.title }), preset: { milestone: m.title } })),
        ];
    }
    if (groupBy.startsWith("scope:")) {
        const scope = groupBy.slice(6);
        const labels = new Map((meta?.labels ?? []).filter((l) => l.scope === scope).map((l) => [l.title, l]));
        for (const item of items) for (const l of item.labels) if (l.scope === scope && !labels.has(l.title)) labels.set(l.title, l);
        const inScope = (item) => item.labels.filter((l) => l.scope === scope).map((l) => l.title);
        return [
            { key: "none", title: `No ${scope}`, lead: () => icon("tag", { size: 14 }), match: (item) => inScope(item).length === 0, patch: (item) => ({ removeLabels: inScope(item) }), preset: {} },
            ...[...labels.values()].sort(byName).map((label) => ({
                key: `l:${label.title}`,
                title: label.value ?? label.title,
                chip: label,
                match: (item) => item.labels.some((l) => l.title === label.title),
                patch: (item) => ({ removeLabels: inScope(item).filter((title) => title !== label.title), addLabels: [label.title] }),
                preset: { labels: [label.title] },
            })),
        ];
    }
    return [
        { key: "open", title: "Open", lead: () => stateIcon("open", { size: 14 }), match: (item) => item.state === "open", patch: () => ({ state: "open" }), preset: {} },
        { key: "closed", title: "Closed", lead: () => stateIcon("closed", { size: 14 }), match: (item) => item.state === "closed", patch: () => ({ state: "closed" }) },
    ];
}

export function mountBoard(root, { onCreate }) {
    const board = h("div", { class: "board", role: "group", "aria-label": "Board" });
    let columns = [];
    let drag = null;
    let deferred = false;

    async function moveCard(item, from, column) {
        if (!item || column.key === from) return;
        const patch = column.patch(item, from);
        if (!patch) return;
        try {
            await patchItem(item.iid, patch, { optimistic: true });
        } catch (error) {
            notifyError(error);
        }
    }

    function openMove(anchor, item, column) {
        togglePicker(anchor, {
            title: `Move #${item.iid} to`,
            options: columns.filter((c) => c.key !== column.key && c.patch).map((c) => ({ value: c.key, label: c.title })),
            onSelect: (key) => moveCard(item, column.key, columns.find((c) => c.key === key)),
        });
    }

    function endDrag() {
        drag = null;
        for (const el of board.querySelectorAll(".dragging, .drop")) el.classList.remove("dragging", "drop");
        if (deferred) render();
    }
    // `dragend` fires on the source card after every drop, so renders are only deferred while a drag is in flight.
    document.addEventListener("dragend", endDrag, true);

    function moveFocus(el, dx, dy) {
        if (dy) {
            const sibling = dy > 0 ? el.nextElementSibling : el.previousElementSibling;
            if (sibling?.classList.contains("card")) sibling.focus();
            return;
        }
        const col = el.closest(".col");
        const target = dx > 0 ? col?.nextElementSibling : col?.previousElementSibling;
        if (!target) return;
        const index = [...col.querySelectorAll(".card")].indexOf(el);
        const cards = target.querySelectorAll(".card");
        cards[Math.min(index, cards.length - 1)]?.focus();
    }

    function cardEl(item, column) {
        const selected = state.view.selected === item.iid;
        const el = h(
            "div",
            {
                class: `card${selected ? " selected" : ""}${item.state === "closed" ? " closed" : ""}`,
                role: "group",
                "aria-label": `#${item.iid} ${item.title}`,
                tabindex: 0,
                draggable: true,
                dataset: { iid: item.iid },
                onclick: () => select(item.iid),
                ondragstart: (event) => {
                    drag = { iid: item.iid, from: column.key, at: Date.now() };
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", `#${item.iid}`);
                    requestAnimationFrame(() => el.classList.add("dragging"));
                },
                onkeydown: (event) => {
                    if (event.target !== el) return;
                    const keys = { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] };
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        select(item.iid);
                    } else if (event.key === "m" || event.key === "M") {
                        event.preventDefault();
                        openMove(el.querySelector(".card-menu"), item, column);
                    } else if (keys[event.key]) {
                        event.preventDefault();
                        moveFocus(el, ...keys[event.key]);
                    }
                },
            },
            h(
                "div",
                { class: "card-top" },
                h("span", { class: "card-id" }, typeIcon(item.type?.name, { size: 13 }), `#${item.iid}`),
                item.confidential ? h("span", { class: "flag", title: "Confidential" }, icon("lock", { size: 12 })) : null,
                item.blocked ? h("span", { class: "flag blocked", title: "Blocked by another item" }, icon("block", { size: 12 })) : null,
                h("span", { class: "tb-spacer" }),
                item.assignees.length ? avatarStack(item.assignees, { size: 20, max: 2 }) : null,
                column.patch
                    ? h("button", { class: "icon-btn card-menu", type: "button", title: "Move to…", "aria-label": `Move #${item.iid} to another column`, onclick: (event) => { event.stopPropagation(); openMove(event.currentTarget, item, column); } }, icon("more", { size: 14 }))
                    : null,
            ),
            h("div", { class: "card-title" }, item.title),
            item.labels.length ? h("div", { class: "card-labels" }, labelChips(item.labels, 3)) : null,
            item.dueDate || item.milestone || item.comments || item.parent
                ? h("div", { class: "card-foot" }, dueBadge(item), milestoneBadge(item), item.parent ? h("span", { class: "meta-chip", title: `Child of #${item.parent.iid} ${item.parent.title}` }, icon("child", { size: 12 }), `#${item.parent.iid}`) : null, item.comments ? h("span", { class: "meta-chip", title: `${item.comments} comments` }, icon("comment", { size: 12 }), item.comments) : null)
                : null,
        );
        return el;
    }

    function autoScroll(event, body) {
        const edge = 48;
        const rect = body.getBoundingClientRect();
        if (event.clientY < rect.top + edge) body.scrollTop -= 14;
        else if (event.clientY > rect.bottom - edge) body.scrollTop += 14;
        const outer = board.getBoundingClientRect();
        if (event.clientX < outer.left + edge) board.scrollLeft -= 18;
        else if (event.clientX > outer.right - edge) board.scrollLeft += 18;
    }

    function columnEl(column, items) {
        const body = h("div", { class: "col-body", dataset: { key: column.key } }, items.length ? items.map((item) => cardEl(item, column)) : h("div", { class: "col-empty" }, "No items"));
        const el = h(
            "section",
            {
                class: "col",
                dataset: { key: column.key },
                "aria-label": `${column.title}, ${items.length} ${items.length === 1 ? "item" : "items"}`,
                ondragover: (event) => {
                    if (!drag || drag.from === column.key || !column.patch) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    el.classList.add("drop");
                    autoScroll(event, body);
                },
                ondragleave: (event) => {
                    if (!el.contains(event.relatedTarget)) el.classList.remove("drop");
                },
                ondrop: (event) => {
                    if (!drag || !column.patch) return;
                    event.preventDefault();
                    const item = state.items.find((candidate) => candidate.iid === drag.iid);
                    const from = drag.from;
                    el.classList.remove("drop");
                    moveCard(item, from, column);
                },
            },
            h(
                "header",
                { class: "col-head" },
                column.chip ? labelChip(column.chip) : [column.lead?.(), h("span", { class: "col-title", title: column.title }, column.title)],
                h("span", { class: "col-count" }, items.length),
                h("span", { class: "tb-spacer" }),
                column.preset ? h("button", { class: "icon-btn", type: "button", title: `New work item in ${column.title}`, "aria-label": `New work item in ${column.title}`, onclick: () => onCreate(column.preset) }, icon("plus", { size: 14 })) : null,
            ),
            body,
        );
        return el;
    }

    function render() {
        if (drag && Date.now() - drag.at < 60_000) {
            deferred = true;
            return;
        }
        drag = null;
        deferred = false;
        const { items } = state;
        const tops = new Map([...board.querySelectorAll(".col-body")].map((el) => [el.dataset.key, el.scrollTop]));
        const active = document.activeElement instanceof Element ? document.activeElement.closest(".card") : null;
        const focus = active && board.contains(active) ? { iid: active.dataset.iid, key: active.closest(".col")?.dataset.key } : null;

        let content = board;
        if (state.loading && !items.length) {
            setChildren(board, ...[0, 1, 2].map(() => h("section", { class: "col skeleton", "aria-hidden": "true" }, h("header", { class: "col-head" }, h("span", { class: "sk sk-line", style: { width: "50%" } })), h("div", { class: "col-body" }, h("span", { class: "sk sk-card" }), h("span", { class: "sk sk-card" })))));
        } else if (state.loadError && !items.length) {
            content = errorBox(state.loadError, (event) => retryLoad(root, event.currentTarget));
        } else if (!items.length) {
            content = filtersActive()
                ? stateBox({ iconName: "filter", title: "No work items match", text: "Try removing a filter or searching for something else.", actions: [h("button", { class: "btn", type: "button", onclick: () => resetFilters() }, "Clear filters")] })
                : stateBox({ iconName: "issue-open", title: "No work items yet", text: "Create the first work item for this project.", actions: [h("button", { class: "btn primary", type: "button", onclick: () => onCreate() }, icon("plus", { size: 14 }), "New work item")] });
        } else {
            columns = buildColumns(state.view.groupBy, items, state.meta);
            setChildren(board, ...columns.map((column) => columnEl(column, items.filter(column.match))));
            for (const body of board.querySelectorAll(".col-body")) body.scrollTop = tops.get(body.dataset.key) ?? 0;
        }

        const banner = state.loadError && items.length ? h("div", { class: "banner error" }, icon("alert", { size: 14 }), h("span", {}, `Could not refresh: ${state.loadError.message}`), h("button", { class: "link-btn", type: "button", onclick: (event) => retryLoad(root, event.currentTarget, { quiet: true }) }, "Retry")) : null;
        const note = items.length && state.hasNextPage ? h("div", { class: "board-note" }, h("span", {}, `Showing ${items.length} of ${state.total} items.`), h("button", { class: "link-btn", type: "button", disabled: state.loadingMore, onclick: (event) => loadMoreItems(root, event.currentTarget, ".board-note .link-btn") }, state.loadingMore ? "Loading…" : "Load more")) : null;
        const left = board.scrollLeft;
        setChildren(root, banner, content, note);
        board.scrollLeft = left;
        if (focus) (board.querySelector(`.col[data-key="${CSS.escape(focus.key ?? "")}"] .card[data-iid="${focus.iid}"]`) ?? board.querySelector(`.card[data-iid="${focus.iid}"]`))?.focus({ preventScroll: true });
    }

    return { render };
}

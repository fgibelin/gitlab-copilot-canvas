// List view: one row per work item, keyboard navigable (Up/Down/Home/End to move, Enter to open).
import { avatarStack, fullTime, h, icon, relTime, setChildren, stateIcon, typeIcon } from "./dom.js";
import { dueBadge, errorBox, labelChips, loadMoreItems, milestoneBadge, retryLoad, skeletonRows, stateBox } from "./parts.js";
import { filtersActive, resetFilters, select, state } from "./state.js";

export function mountList(root, { onCreate }) {
    const rowFor = (item, tabbable) => {
        const selected = state.view.selected === item.iid;
        return h(
            "div",
            {
                class: `row${selected ? " selected" : ""}${item.state === "closed" ? " closed" : ""}`,
                role: "option",
                "aria-selected": String(selected),
                tabindex: tabbable ? 0 : -1,
                dataset: { iid: item.iid },
                onclick: () => select(item.iid),
            },
            stateIcon(item.state, { size: 16, cls: "row-state" }),
            h(
                "div",
                { class: "row-main" },
                h("div", { class: "row-title" }, h("span", { class: "title-text" }, item.title), item.confidential ? h("span", { class: "flag", title: "Confidential" }, icon("lock", { size: 13 })) : null, item.blocked ? h("span", { class: "flag blocked", title: "Blocked by another item" }, icon("block", { size: 13 })) : null, labelChips(item.labels)),
                h(
                    "div",
                    { class: "row-meta" },
                    h("span", { class: "meta-id" }, `#${item.iid}`),
                    h("span", { class: "meta-chip" }, typeIcon(item.type?.name, { size: 12 }), item.type?.name ?? "Item"),
                    h("time", { class: "meta-time", datetime: item.updatedAt, title: fullTime(item.updatedAt) }, `updated ${relTime(item.updatedAt)}`),
                    milestoneBadge(item),
                    dueBadge(item),
                    item.parent ? h("span", { class: "meta-chip", title: `Child of #${item.parent.iid} ${item.parent.title}` }, icon("child", { size: 12 }), `#${item.parent.iid}`) : null,
                    item.comments ? h("span", { class: "meta-chip", title: `${item.comments} comments` }, icon("comment", { size: 12 }), item.comments) : null,
                ),
            ),
            h("div", { class: "row-side" }, item.assignees.length ? avatarStack(item.assignees, { size: 22 }) : null),
        );
    };

    root.addEventListener("keydown", (event) => {
        const row = event.target instanceof Element ? event.target.closest(".row[data-iid]") : null;
        if (!row) return;
        const rows = [...root.querySelectorAll(".row[data-iid]")];
        const index = rows.indexOf(row);
        let next;
        if (event.key === "ArrowDown") next = rows[index + 1];
        else if (event.key === "ArrowUp") next = rows[index - 1];
        else if (event.key === "Home") next = rows[0];
        else if (event.key === "End") next = rows.at(-1);
        else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(Number(row.dataset.iid));
            return;
        } else return;
        event.preventDefault();
        if (next) {
            for (const other of rows) other.tabIndex = -1;
            next.tabIndex = 0;
            next.focus();
        }
    });

    function render() {
        const focused = root.contains(document.activeElement) ? document.activeElement.closest?.(".row")?.dataset.iid : null;
        const { items } = state;
        let body;
        if (state.loading && !items.length) {
            body = h("div", { class: "rows", "aria-busy": "true" }, skeletonRows());
        } else if (state.loadError && !items.length) {
            body = errorBox(state.loadError, (event) => retryLoad(root, event.currentTarget));
        } else if (!items.length) {
            body = filtersActive()
                ? stateBox({ iconName: "filter", title: "No work items match", text: "Try removing a filter or searching for something else.", actions: [h("button", { class: "btn", type: "button", onclick: () => resetFilters() }, "Clear filters")] })
                : stateBox({ iconName: "issue-open", title: "No work items yet", text: "Create the first work item for this project.", actions: [h("button", { class: "btn primary", type: "button", onclick: () => onCreate() }, icon("plus", { size: 14 }), "New work item")] });
        } else {
            const selectedIndex = items.findIndex((item) => item.iid === state.view.selected);
            const tabbable = selectedIndex >= 0 ? selectedIndex : 0;
            body = h("div", { class: "rows", role: "listbox", "aria-label": "Work items", "aria-busy": state.loading ? "true" : null }, items.map((item, index) => rowFor(item, index === tabbable)));
        }
        const banner = state.loadError && items.length ? h("div", { class: "banner error" }, icon("alert", { size: 14 }), h("span", {}, `Could not refresh: ${state.loadError.message}`), h("button", { class: "link-btn", type: "button", onclick: (event) => retryLoad(root, event.currentTarget, { quiet: true }) }, "Retry")) : null;
        const more = items.length && state.hasNextPage
            ? h("div", { class: "more" }, h("button", { class: "btn", type: "button", disabled: state.loadingMore, onclick: (event) => loadMoreItems(root, event.currentTarget, ".more .btn") }, state.loadingMore ? "Loading…" : `Load more (${items.length} of ${state.total})`))
            : null;
        setChildren(root, banner, body, more);
        if (focused) root.querySelector(`.row[data-iid="${focused}"]`)?.focus({ preventScroll: true });
    }

    return { render };
}

// Small pieces shared by the list, the board and the detail pane.
import { dayLabel, dueStatus, h, icon, labelChip } from "./dom.js";
import { loadItems, notifyError, state } from "./state.js";

export function stateBox({ iconName = "issue-open", title, text, actions = [], tone = "" }) {
    return h(
        "div",
        { class: `state-box ${tone}`.trim() },
        h("div", { class: "state-box-icon" }, icon(iconName, { size: 28 })),
        h("h2", {}, title),
        text ? h("p", {}, text) : null,
        actions.length ? h("div", { class: "state-box-actions" }, actions) : null,
    );
}

export const errorBox = (error, retry, title = "Could not load work items") =>
    stateBox({
        iconName: "alert",
        tone: "error",
        title,
        text: error?.message ?? String(error),
        actions: retry ? [h("button", { class: "btn", type: "button", onclick: retry }, "Try again")] : [],
    });

// Re-running a load re-renders the view and replaces the control that started it, which would leave keyboard focus on <body>.
// When the control held focus, `pick` chooses what takes it over once the load has settled; if focus has moved elsewhere in
// the meantime, leave it alone.
async function holdFocus(trigger, load, pick) {
    const hadFocus = document.activeElement === trigger;
    await load();
    const idle = !document.activeElement || document.activeElement === document.body;
    if (hadFocus && idle) pick()?.focus();
}

// Focus goes to the first new item, or back to the rebuilt button (found with `selector`) when nothing came in so it can be
// pressed again. A failure is toasted because the list's error banner sits at the top, usually out of sight of the button.
export function loadMoreItems(container, trigger, selector) {
    const before = state.items.length;
    return holdFocus(
        trigger,
        async () => {
            await loadItems({ more: true });
            if (state.loadError) notifyError(new Error(`Could not load more work items: ${state.loadError.message}`));
        },
        () => {
            const first = state.items[before];
            return container.querySelector(first ? `[data-iid="${first.iid}"]` : selector);
        },
    );
}

// The error banner's Retry and the full-page error box's "Try again": focus goes to the tabbable item once the data is back,
// or to whichever retry control replaces this one when it fails again.
export const retryLoad = (container, trigger, options) => holdFocus(trigger, () => loadItems(options), () => container.querySelector(state.loadError ? ".banner .link-btn, .state-box .btn" : "[data-iid][tabindex='0']"));

export function labelChips(labels, max = 4) {
    const rest = labels.slice(max);
    return [...labels.slice(0, max).map(labelChip), rest.length ? h("span", { class: "chip more", title: rest.map((l) => l.title).join(", ") }, h("span", { class: "chip-text" }, `+${rest.length}`)) : null];
}

export function dueBadge(item) {
    if (!item.dueDate) return null;
    const status = dueStatus(item.dueDate, item.state);
    const title = status === "overdue" ? `Overdue: due ${item.dueDate}` : `Due ${item.dueDate}`;
    return h("span", { class: `meta-chip due ${status}`.trim(), title }, icon("calendar", { size: 12 }), dayLabel(item.dueDate));
}

export const milestoneBadge = (item) => (item.milestone ? h("span", { class: "meta-chip", title: `Milestone: ${item.milestone.title}` }, icon("milestone", { size: 12 }), item.milestone.title) : null);

export const skeletonRows = (count = 6) => Array.from({ length: count }, (_, i) => h("div", { class: "row skeleton", "aria-hidden": "true" }, h("span", { class: "sk sk-dot" }), h("div", { class: "row-main" }, h("span", { class: "sk sk-line", style: { width: `${52 + ((i * 17) % 38)}%` } }), h("span", { class: "sk sk-line short" }))));

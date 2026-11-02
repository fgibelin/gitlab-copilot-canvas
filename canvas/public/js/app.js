// Entry point: boots the store, mounts the regions and routes keyboard shortcuts.
import { authorized } from "./api.js";
import { mountBoard } from "./board.js";
import { dialogOpen, openCreateDialog } from "./create.js";
import { mountDetail } from "./detail.js";
import { h, setChildren } from "./dom.js";
import { mountList } from "./list.js";
import { mountMergeRequests } from "./merge-requests.js";
import { skeletonRows, stateBox } from "./parts.js";
import { closePicker, pickerOpen } from "./pickers.js";
import { boot, on, refreshAll, select, startLive, state, switchProject } from "./state.js";
import { mountToolbar } from "./toolbar.js";

const $ = (id) => document.getElementById(id);
const els = { toolbar: $("toolbar"), main: $("main"), content: $("content"), detail: $("detail") };

const listRoot = h("div", { class: "view-root", id: "list-root" });
const boardRoot = h("div", { class: "view-root", id: "board-root", hidden: true });
const mergeRequestsRoot = h("div", { class: "view-root", id: "merge-requests-root", hidden: true });
const screenRoot = h("div", { class: "screen", id: "screen-root" });
els.content.append(listRoot, boardRoot, mergeRequestsRoot, screenRoot);

const openCreate = (preset) => state.phase === "ready" && !dialogOpen() && openCreateDialog(preset ?? {});

const toolbar = mountToolbar(els.toolbar, { onCreate: openCreate });
const list = mountList(listRoot, { onCreate: openCreate });
const board = mountBoard(boardRoot, { onCreate: openCreate });
const mergeRequests = mountMergeRequests(mergeRequestsRoot);
const detail = mountDetail(els.detail, { onClose: () => select(null) });

// ---- screens shown instead of the work items --------------------------------------------------------------------------
function projectForm(initial = "") {
    const input = h("input", { class: "input", type: "text", placeholder: "group/project or https://gitlab.com/group/project", "aria-label": "GitLab project", autocomplete: "off", spellcheck: "false" });
    input.value = initial;
    const error = h("div", { class: "ed-error", role: "alert", hidden: true });
    const button = h("button", { class: "btn primary", type: "submit" }, "Open project");
    return h(
        "form",
        {
            class: "project-form",
            onsubmit: async (event) => {
                event.preventDefault();
                const text = input.value.trim();
                if (!text) return;
                input.disabled = button.disabled = true;
                error.hidden = true;
                try {
                    await switchProject(text);
                } catch (failure) {
                    error.textContent = failure.message;
                    error.hidden = false;
                    input.disabled = button.disabled = false;
                    input.focus();
                }
            },
        },
        h("div", { class: "project-form-row" }, input, button),
        error,
    );
}

function renderScreen() {
    const { phase } = state;
    if (phase === "boot") {
        setChildren(screenRoot, h("div", { class: "rows", "aria-busy": "true", "aria-label": "Loading work items" }, skeletonRows(8)));
    } else if (phase === "no-project") {
        setChildren(screenRoot,
            h("div", { class: "screen-card" }, stateBox({ iconName: "milestone", title: "Choose a GitLab project", text: state.problem ?? "Enter the project whose work items you want to manage." }), projectForm()),
        );
    } else if (phase === "error") {
        const fatal = state.fatal ?? { code: "error", message: "Something went wrong." };
        const unauthorised = fatal.code === "no_token";
        const retry = unauthorised ? [] : [h("button", { class: "btn", type: "button", onclick: () => boot() }, "Try again")];
        setChildren(screenRoot,
            h(
                "div",
                { class: "screen-card" },
                stateBox({ iconName: "alert", tone: "error", title: unauthorised ? "This panel is not authorised" : "Could not load work items", text: fatal.message, actions: retry }),
                unauthorised ? null : h("p", { class: "screen-or" }, "Or open a different project"),
                unauthorised ? null : projectForm(state.project?.path ?? ""),
            ),
        );
    }
}

// ---- state -> regions ---------------------------------------------------------------------------------------------------
function renderBody() {
    const ready = state.phase === "ready";
    const mergeRequestMode = ready && state.domain === "merge_requests";
    const boardMode = ready && state.view.mode === "board";
    els.toolbar.hidden = !ready;
    els.content.classList.toggle("is-board", boardMode && !mergeRequestMode);
    listRoot.hidden = !ready || boardMode || mergeRequestMode;
    boardRoot.hidden = !boardMode || mergeRequestMode;
    mergeRequestsRoot.hidden = !mergeRequestMode;
    screenRoot.hidden = ready;
    if (!ready) renderScreen();
    else if (mergeRequestMode) mergeRequests.render();
    else (boardMode ? board : list).render();
}

// Hiding the drawer while it holds focus would drop focus on <body>, so the row or card of the item it was showing gets it back
// instead. `shown` is that item; `from`, the one the drawer was opened for, stands in when `shown` is not in the current list.
let drawerItems = null;

const focusItem = (iid) => {
    const root = state.view.mode === "board" ? boardRoot : listRoot;
    const target = root.querySelector(`.row[data-iid="${iid}"], .card[data-iid="${iid}"]`);
    target?.focus();
    return Boolean(target);
};

// Only when this document is focused: calling focus() from an unfocused iframe would pull focus away from the host app.
const drawerHoldsFocus = () => document.hasFocus() && (els.detail.contains(document.activeElement) || document.activeElement === document.body);

function renderDetail() {
    const shown = state.phase === "ready" && state.domain === "items" ? state.view.selected : null;
    if (shown !== null) {
        if (drawerItems) drawerItems.shown = shown;
        else drawerItems = { from: shown, shown };
        detail.render();
        return;
    }
    const closing = drawerItems;
    const handBack = state.domain === "items" && closing !== null && drawerHoldsFocus();
    drawerItems = null;
    els.detail.hidden = true;
    if (state.phase === "ready" && state.domain === "items") detail.render();
    else els.detail.hidden = true;
    if (handBack) focusItem(closing.shown) || focusItem(closing.from);
}

const syncToolbar = () => state.phase === "ready" && toolbar.sync();

on("phase", () => {
    syncToolbar();
    renderBody();
    renderDetail();
});
on("view", () => {
    syncToolbar();
    renderBody();
    renderDetail();
});
on("domain", () => {
    syncToolbar();
    renderBody();
    renderDetail();
});
on("meta", () => {
    syncToolbar();
    renderBody();
    renderDetail();
});
on("items", () => {
    syncToolbar();
    renderBody();
});
on("status", syncToolbar);
on("detail", renderDetail);

// ---- keyboard ---------------------------------------------------------------------------------------------------------
const isTyping = (target) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || dialogOpen() || document.querySelector("dialog[open]")) return;
    if (event.key === "Escape") {
        if (pickerOpen()) closePicker();
        else if (isTyping(event.target)) event.target.blur();
        else if (state.domain === "merge_requests") mergeRequests.closeDetail();
        else if (state.view.selected !== null) select(null);
        return;
    }
    if (state.phase !== "ready" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    if (event.key === "/") {
        event.preventDefault();
        if (state.domain === "merge_requests") mergeRequests.focusSearch();
        else toolbar.focusSearch();
    } else if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        if (state.domain === "merge_requests") mergeRequests.create();
        else openCreate();
    } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        if (state.domain === "merge_requests") mergeRequests.refresh();
        else refreshAll({ meta: true });
    }
});

renderBody();
startLive();
boot();

if (!authorized) console.warn("Work items canvas: opened without an access token.");

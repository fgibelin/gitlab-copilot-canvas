// "New work item" dialog. Opened from the toolbar, the empty states and the "+" button of every board column.
import { h, icon, toast } from "./dom.js";
import { markdownEditor } from "./editor.js";
import { renderMarkdown } from "./md.js";
import { closePicker, pickerOpen, togglePicker } from "./pickers.js";
import { createItem, labelScopeOf, state } from "./state.js";
import { filterButton, labelOption, milestoneOption, personOption, typeOption } from "./toolbar.js";

let current = null;
export const dialogOpen = () => current !== null;

const TABBABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';
const MOD = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** @param {{ type?: string, assignees?: string[], labels?: string[], milestone?: string }} [preset] */
export function openCreateDialog(preset = {}) {
    if (current) {
        current.focus();
        return;
    }
    const meta = state.meta;
    if (!meta) return;

    const opener = document.activeElement;
    const types = meta.types ?? [];
    const form = {
        type: preset.type ?? types.find((type) => type.name === "Issue")?.name ?? types[0]?.name ?? "Issue",
        assignees: [...(preset.assignees ?? [])],
        labels: [...(preset.labels ?? [])],
        milestone: preset.milestone ?? "",
    };
    let busy = false;
    let closed = false;
    let discardArmed = false;

    const titleInput = h("input", { class: "dlg-title", type: "text", maxlength: 255, placeholder: "Title", "aria-label": "Title", autocomplete: "off", spellcheck: "true" });
    const editor = markdownEditor({
        label: "Description",
        placeholder: "Add a description (optional). Markdown is supported.",
        rows: 6,
        renderPreview: (text) => renderMarkdown(text, { base: meta.project?.webUrl ? `${meta.project.webUrl.replace(/\/$/, "")}/` : null }),
    });
    const due = h("input", { class: "date-input", type: "date", "aria-label": "Due date" });
    const confidential = h("input", { type: "checkbox", "aria-label": "Confidential" });

    const typeBtn = filterButton("task", "Type", (anchor) =>
        togglePicker(anchor, {
            title: "Type",
            selected: form.type,
            options: types.map(typeOption),
            onSelect: (value) => {
                form.type = value;
                paint();
            },
        }),
    );
    const assigneeBtn = filterButton("person", "Assignees", (anchor) =>
        togglePicker(anchor, {
            title: "Assignees",
            multi: true,
            immediate: true,
            searchable: meta.members.length > 6,
            searchPlaceholder: "Filter people…",
            selected: form.assignees,
            options: meta.members.map(personOption),
            emptyText: "No project members found.",
            onSelect: (usernames) => {
                form.assignees = usernames;
                paint();
            },
        }),
    );
    const labelBtn = filterButton("tag", "Labels", (anchor) =>
        togglePicker(anchor, {
            title: "Labels",
            multi: true,
            immediate: true,
            searchable: true,
            searchPlaceholder: "Filter labels…",
            selected: form.labels,
            options: meta.labels.map(labelOption),
            exclusiveGroup: labelScopeOf(),
            emptyText: "This project has no labels yet.",
            onSelect: (titles) => {
                form.labels = titles;
                paint();
            },
        }),
    );
    const milestoneBtn = filterButton("milestone", "Milestone", (anchor) =>
        togglePicker(anchor, {
            title: "Milestone",
            selected: form.milestone,
            options: [{ value: "", label: "No milestone" }, ...meta.milestones.map(milestoneOption)],
            onSelect: (value) => {
                form.milestone = value;
                paint();
            },
        }),
    );

    const error = h("div", { class: "dlg-error", role: "alert", hidden: true });
    const hint = h("span", { class: "dlg-hint" }, `${MOD} Enter to create`);
    const createBtn = h("button", { class: "btn primary", type: "button", onclick: () => submit() }, "Create work item");
    const cancelBtn = h("button", { class: "btn", type: "button", onclick: () => close() }, "Cancel");
    const closeBtn = h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: () => close() }, icon("x", { size: 15 }));

    const fields = h(
        "fieldset",
        { class: "dlg-fields" },
        titleInput,
        editor.el,
        h(
            "div",
            { class: "dlg-props" },
            typeBtn.el,
            assigneeBtn.el,
            labelBtn.el,
            milestoneBtn.el,
            h("label", { class: "dlg-date" }, icon("clock", { size: 14 }), h("span", {}, "Due"), due),
            h("label", { class: "check" }, confidential, h("span", {}, "Confidential")),
        ),
    );
    const dialog = h(
        "div",
        { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dlg-heading", "aria-describedby": "dlg-error" },
        h("header", { class: "dlg-head" }, h("h2", { id: "dlg-heading" }, "New work item"), h("span", { class: "tb-spacer" }), closeBtn),
        h("div", { class: "dlg-body" }, fields),
        h("footer", { class: "dlg-foot" }, h("div", { class: "dlg-foot-msg", id: "dlg-error" }, error, hint), cancelBtn, createBtn),
    );
    const backdrop = h("div", { class: "dialog-backdrop", onpointerdown: (event) => event.target === backdrop && requestClose() }, dialog);

    const snapshot = () => JSON.stringify([titleInput.value.trim(), editor.value.trim(), form, due.value, confidential.checked]);
    let initial = "";

    function paint() {
        const count = (list, noun) => (list.length > 2 ? `${list.length} ${noun}` : list.join(", "));
        typeBtn.set(form.type, { disabled: types.length < 2 });
        assigneeBtn.set(count(form.assignees.map((name) => `@${name}`), "people"), { active: form.assignees.length > 0, disabled: meta.members.length === 0 && form.assignees.length === 0, title: meta.members.length === 0 ? "No project members found" : "" });
        labelBtn.set(count(form.labels, "labels"), { active: form.labels.length > 0, disabled: meta.labels.length === 0 && form.labels.length === 0, title: meta.labels.length === 0 ? "This project has no labels yet" : "" });
        milestoneBtn.set(form.milestone, { active: Boolean(form.milestone), disabled: meta.milestones.length === 0 && !form.milestone, title: meta.milestones.length === 0 ? "This project has no milestones yet" : "" });
        disarm();
    }

    function show(message) {
        error.textContent = message ?? "";
        error.hidden = !message;
        hint.hidden = Boolean(message);
    }

    function disarm() {
        if (!discardArmed) return;
        discardArmed = false;
        show("");
    }

    function requestClose() {
        if (busy) return;
        if (snapshot() === initial || discardArmed) return close();
        discardArmed = true;
        show("Discard this draft? Press Esc again to close without creating it.");
    }

    function close() {
        if (closed || busy) return;
        closed = true;
        document.removeEventListener("keydown", onKey, true);
        closePicker({ restoreFocus: false });
        backdrop.remove();
        current = null;
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    }

    function payload() {
        const data = { title: titleInput.value.trim(), type: form.type };
        if (editor.value.trim()) data.description = editor.value;
        if (form.labels.length) data.labels = form.labels;
        if (form.assignees.length) data.assignees = form.assignees;
        if (form.milestone) data.milestone = form.milestone;
        if (due.value) data.dueDate = due.value;
        if (confidential.checked) data.confidential = true;
        return data;
    }

    async function submit() {
        if (busy) return;
        if (!titleInput.value.trim()) {
            show("A title is required.");
            titleInput.focus();
            return;
        }
        show("");
        busy = true;
        fields.disabled = createBtn.disabled = cancelBtn.disabled = closeBtn.disabled = true;
        createBtn.textContent = "Creating…";
        try {
            const created = await createItem(payload());
            busy = false;
            close();
            toast(`Created #${created.iid}: ${created.title}`);
        } catch (failure) {
            busy = false;
            fields.disabled = createBtn.disabled = cancelBtn.disabled = closeBtn.disabled = false;
            createBtn.textContent = "Create work item";
            show(failure?.message ?? "Could not create the work item.");
            titleInput.focus();
        }
    }

    function trapTab(event) {
        const items = [...dialog.querySelectorAll(TABBABLE)].filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
        if (!items.length) return;
        const active = document.activeElement;
        if (!dialog.contains(active)) {
            event.preventDefault();
            items[0].focus();
        } else if (event.shiftKey && active === items[0]) {
            event.preventDefault();
            items.at(-1).focus();
        } else if (!event.shiftKey && active === items.at(-1)) {
            event.preventDefault();
            items[0].focus();
        }
    }

    // Registered in the capture phase so the dialog owns the keyboard while it is open (an open picker still gets its own keys).
    function onKey(event) {
        if (pickerOpen() || event.isComposing) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            requestClose();
        } else if (event.key === "Tab") trapTab(event);
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            submit();
        }
    }

    titleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.isComposing) {
            event.preventDefault();
            submit();
        }
    });
    for (const input of [titleInput, editor.textarea, due, confidential]) input.addEventListener("input", disarm);

    paint();
    initial = snapshot();
    current = { close, focus: () => titleInput.focus() };
    document.getElementById("layer").append(backdrop);
    document.addEventListener("keydown", onKey, true);
    titleInput.focus();
}

// A Markdown text editor with Write/Preview tabs. Used for descriptions, comments and the create dialog.
import { h, setChildren } from "./dom.js";

const MAX_HEIGHT = 420;

/**
 * @param {object} options
 * @param {string} [options.value]
 * @param {string} [options.label]          accessible name of the text area
 * @param {string} [options.placeholder]
 * @param {number} [options.rows]
 * @param {string} [options.submitLabel]    when set, the editor shows a submit button
 * @param {string} [options.cancelLabel]    when set (with onCancel), the editor shows a cancel button
 * @param {boolean} [options.allowEmpty]    whether an empty text may be submitted
 * @param {(text: string) => Promise<void> | void} [options.onSubmit]   a rejection is shown inline and keeps the text
 * @param {() => void} [options.onCancel]
 * @param {(text: string) => Node} [options.renderPreview]
 */
export function markdownEditor({ value = "", label = "Text", placeholder = "", rows = 6, submitLabel = "", cancelLabel = "Cancel", allowEmpty = false, onSubmit, onCancel, renderPreview } = {}) {
    let initial = value;
    let busy = false;
    let disabled = false;
    let previewing = false;

    const textarea = h("textarea", { class: "ed-input", rows, placeholder, "aria-label": label, spellcheck: "true" });
    textarea.value = value;
    const preview = h("div", { class: "ed-preview", hidden: true });
    const error = h("div", { class: "ed-error", role: "alert", hidden: true });
    const hint = h("span", { class: "ed-hint" }, "Markdown is supported");

    const writeTab = h("button", { class: "ed-tab on", type: "button", "aria-pressed": "true", onclick: () => setPreview(false) }, "Write");
    const previewTab = h("button", { class: "ed-tab", type: "button", "aria-pressed": "false", onclick: () => setPreview(true) }, "Preview");
    const tabs = renderPreview ? h("div", { class: "ed-tabs", role: "group", "aria-label": "Editor mode" }, writeTab, previewTab) : null;

    const submit = submitLabel ? h("button", { class: "btn primary small", type: "button", onclick: () => send() }, submitLabel) : null;
    const cancel = onCancel ? h("button", { class: "btn ghost small", type: "button", onclick: () => onCancel() }, cancelLabel) : null;
    const actions = submit || cancel ? h("div", { class: "ed-actions" }, hint, h("span", { class: "tb-spacer" }), cancel, submit) : null;
    const el = h("div", { class: "editor" }, tabs, textarea, preview, error, actions);

    function autosize() {
        if (!textarea.isConnected || previewing) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight + 2, MAX_HEIGHT)}px`;
    }

    function setPreview(on) {
        if (!renderPreview) return;
        previewing = on;
        writeTab.classList.toggle("on", !on);
        previewTab.classList.toggle("on", on);
        writeTab.setAttribute("aria-pressed", String(!on));
        previewTab.setAttribute("aria-pressed", String(on));
        textarea.hidden = on;
        preview.hidden = !on;
        if (on) {
            const text = textarea.value;
            setChildren(preview, text.trim() ? renderPreview(text) : h("p", { class: "d-empty" }, "Nothing to preview."));
        } else {
            autosize();
            textarea.focus({ preventScroll: true });
        }
    }

    function paintState() {
        // While submitting the field is read-only rather than disabled: a disabled field drops keyboard focus.
        textarea.disabled = disabled;
        textarea.readOnly = busy;
        if (submit) submit.disabled = busy || disabled;
        if (cancel) cancel.disabled = busy;
        writeTab.disabled = previewTab.disabled = busy || disabled;
        el.classList.toggle("busy", busy);
    }

    function showError(message) {
        error.textContent = message ?? "";
        error.hidden = !message;
    }

    async function send() {
        if (busy || disabled || !onSubmit) return;
        const text = textarea.value;
        if (!allowEmpty && !text.trim()) {
            showError("Write something first.");
            textarea.focus();
            return;
        }
        showError("");
        busy = true;
        paintState();
        try {
            await onSubmit(text);
        } catch (failure) {
            showError(failure?.message ?? "Could not save.");
        } finally {
            // Disabling the submit button that was just used drops focus; hand it back unless the user moved on.
            const lost = !document.activeElement || document.activeElement === document.body;
            busy = false;
            paintState();
            if (lost && el.isConnected && !textarea.hidden) textarea.focus({ preventScroll: true });
        }
    }

    textarea.addEventListener("input", () => {
        autosize();
        if (error.textContent) showError("");
    });
    textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
        } else if (event.key === "Escape" && onCancel) {
            // Escape belongs to the editor while it is focused: it must not also close the drawer behind it.
            event.stopPropagation();
            if (textarea.value === initial) onCancel();
            else showError("You have unsaved changes. Use Cancel to discard them.");
        }
    });
    requestAnimationFrame(autosize);

    return {
        el,
        textarea,
        get value() {
            return textarea.value;
        },
        set value(text) {
            textarea.value = text;
            initial = text;
            setPreview(false);
            autosize();
        },
        get dirty() {
            return textarea.value !== initial;
        },
        get busy() {
            return busy;
        },
        focus({ end = false } = {}) {
            textarea.focus({ preventScroll: false });
            if (end) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        },
        setDisabled(flag) {
            disabled = Boolean(flag);
            paintState();
        },
        showError,
    };
}

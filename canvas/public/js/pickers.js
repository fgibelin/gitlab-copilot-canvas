// Anchored popover menus: single or multi select, optional search over static or async options.
// Options look like { value, label, hint?, keywords?, group?, disabled?, render?: () => Node }.
// A multi-select can pass `exclusiveGroup(value)`: choosing a value drops the other chosen values that return the same non-empty group.
import { h, icon, debounce } from "./dom.js";

const LIMIT = 200;
let current = null;
let counter = 0;

export const closePicker = (opts) => current?.close(opts);
export const pickerOpen = () => current !== null;

/** Clicking an anchor that already owns the open picker closes it instead of reopening it. */
export function togglePicker(anchor, config) {
    if (current?.anchor === anchor) {
        current.close();
        return null;
    }
    return openPicker(anchor, config);
}

export function openPicker(anchor, config = {}) {
    current?.close({ restoreFocus: false });

    const layer = document.getElementById("layer");
    const multi = Boolean(config.multi);
    const immediate = multi && Boolean(config.immediate);
    const isAsync = typeof config.options === "function";
    const searchable = config.searchable ?? isAsync;
    const uid = `pick${++counter}`;
    const initial = new Set(multi ? (config.selected ?? []) : []);
    const picked = new Set(initial);
    const single = multi ? null : (config.selected ?? null);

    let shown = [];
    let active = -1;
    let status = "ready";
    let errorText = "";
    let query = "";
    let seq = 0;
    let closed = false;
    // Typing is debounced before the options reload, so Enter in that window must wait for the new results instead of picking from the old list.
    let queued = false;
    let enterWhenReady = false;
    const outdated = () => queued || status === "loading";

    const matches = (option) => !query || `${option.label} ${option.hint ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(query);
    const filterStatic = () => (config.options ?? []).filter(matches);
    const isOn = (option) => (multi ? picked.has(option.value) : option.value === single);

    const input = searchable
        ? h("input", {
              class: "pick-search",
              type: "text",
              placeholder: config.searchPlaceholder ?? "Filter…",
              "aria-label": config.searchPlaceholder ?? "Filter",
              autocomplete: "off",
              spellcheck: "false",
              role: "combobox",
              "aria-controls": `${uid}-list`,
              "aria-expanded": "true",
              "aria-autocomplete": "list",
              oninput: () => onQuery(input.value.trim().toLowerCase()),
          })
        : null;
    const list = h("div", { class: "pick-list", id: `${uid}-list`, role: "listbox", "aria-multiselectable": multi ? "true" : null, "aria-label": config.title ?? "Options", tabindex: input ? null : 0 });
    const doneButton = multi && !immediate ? h("button", { class: "btn primary small", type: "button", onclick: () => close() }, "Done") : null;
    const clearButton = multi ? h("button", { class: "btn ghost small", type: "button", onclick: clearAll }, "Clear") : null;
    const foot = config.footer || multi ? h("div", { class: "pick-foot" }, config.footer ? h("span", { class: "pick-footnote" }, config.footer) : h("span", {}), h("span", { class: "pick-actions" }, clearButton, doneButton)) : null;
    const pop = h("div", { class: "popover picker", onkeydown: onKey, onmousedown: keepFocus }, config.title ? h("div", { class: "pick-title" }, config.title) : null, input, list, foot);

    // A click on a row, a note or a button must not pull focus out of the picker, or Esc, Tab and the arrow keys go dead.
    function keepFocus(event) {
        if (event.target !== list && !(event.target instanceof HTMLInputElement)) event.preventDefault();
    }

    function paintFoot() {
        if (clearButton) clearButton.hidden = picked.size === 0;
    }

    function paint() {
        const top = list.scrollTop;
        list.replaceChildren();
        if (status === "error") list.append(h("div", { class: "pick-note error" }, errorText));
        else if (status === "loading" && !shown.length) list.append(h("div", { class: "pick-note" }, "Loading…"));
        else if (!shown.length) list.append(h("div", { class: "pick-note" }, config.emptyText ?? "No matches"));
        let group;
        const visible = shown.slice(0, LIMIT);
        visible.forEach((option, index) => {
            if (option.group && option.group !== group) {
                group = option.group;
                list.append(h("div", { class: "pick-group", role: "presentation" }, group));
            }
            list.append(row(option, index));
        });
        if (shown.length > LIMIT) list.append(h("div", { class: "pick-note" }, `Showing the first ${LIMIT} of ${shown.length}. Type to narrow the list.`));
        list.scrollTop = top;
        paintFoot();
        setActive(Math.min(active, visible.length - 1), { scroll: false });
        place();
    }

    function row(option, index) {
        const on = isOn(option);
        return h(
            "div",
            {
                class: `pick-row${on ? " selected" : ""}${option.disabled ? " disabled" : ""}${option.muted ? " muted" : ""}`,
                id: `${uid}-${index}`,
                role: "option",
                "aria-selected": String(on),
                "aria-disabled": option.disabled ? "true" : null,
                dataset: { index },
                onmousemove: () => active !== index && setActive(index, { scroll: false }),
                onclick: () => choose(index),
            },
            multi ? h("span", { class: `pick-check${on ? " on" : ""}` }, on ? icon("check", { size: 12 }) : null) : null,
            option.render ? option.render() : h("span", { class: "pick-label" }, option.label),
            option.hint && !option.render ? h("span", { class: "pick-hint" }, option.hint) : null,
            !multi && on ? icon("check", { size: 14, cls: "pick-tick" }) : null,
        );
    }

    function setActive(index, { scroll = true } = {}) {
        const rows = list.querySelectorAll(".pick-row");
        active = rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : -1;
        rows.forEach((el, i) => el.classList.toggle("active", i === active));
        const target = input ?? list;
        if (active >= 0) target.setAttribute("aria-activedescendant", rows[active].id);
        else target.removeAttribute("aria-activedescendant");
        if (scroll && active >= 0) rows[active].scrollIntoView({ block: "nearest" });
    }

    function choose(index) {
        const option = shown[index];
        if (!option || option.disabled) return;
        if (multi) {
            if (picked.has(option.value)) picked.delete(option.value);
            else {
                picked.add(option.value);
                const group = config.exclusiveGroup?.(option.value);
                if (group) for (const other of [...picked]) if (other !== option.value && config.exclusiveGroup(other) === group) picked.delete(other);
            }
            if (immediate) config.onSelect?.([...picked]);
            active = index;
            paint();
            return;
        }
        const changed = option.value !== single;
        close();
        if (changed || config.always) config.onSelect?.(option.value, option);
    }

    function clearAll() {
        picked.clear();
        if (immediate) config.onSelect?.([]);
        paint();
        (input ?? list).focus({ preventScroll: true });
    }

    function place() {
        if (!pop.isConnected) return;
        const rect = anchor.getBoundingClientRect();
        const margin = 8;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const width = Math.min(Math.max(config.width ?? 240, Math.min(rect.width, 360)), vw - margin * 2);
        pop.style.width = `${width}px`;
        list.style.maxHeight = "none";
        const chrome = pop.offsetHeight - list.offsetHeight;
        const natural = Math.min(list.scrollHeight, 320);
        const below = vh - rect.bottom - margin - 4;
        const above = rect.top - margin - 4;
        const placeBelow = below >= natural + chrome || below >= above;
        const room = placeBelow ? below : above;
        list.style.maxHeight = `${Math.max(96, Math.min(320, room - chrome))}px`;
        pop.style.left = `${Math.min(Math.max(margin, rect.left), vw - width - margin)}px`;
        pop.style.top = placeBelow ? `${rect.bottom + 4}px` : "auto";
        pop.style.bottom = placeBelow ? "auto" : `${vh - rect.top + 4}px`;
        pop.dataset.side = placeBelow ? "below" : "above";
    }

    const search = debounce((text) => load(text), 220);

    function onQuery(text) {
        query = text;
        if (isAsync) {
            queued = true;
            enterWhenReady = false;
            search(text);
        } else {
            shown = filterStatic();
            active = shown.length ? 0 : -1;
            paint();
        }
    }

    async function load(text) {
        const mine = ++seq;
        queued = false;
        status = "loading";
        list.setAttribute("aria-busy", "true");
        if (!shown.length) paint();
        try {
            const result = await config.options(text);
            if (mine !== seq || closed) return;
            shown = result;
            status = "ready";
        } catch (error) {
            if (mine !== seq || closed) return;
            shown = [];
            status = "error";
            errorText = error?.message ?? "Could not load the options.";
        }
        list.removeAttribute("aria-busy");
        active = shown.length ? 0 : -1;
        paint();
        if (enterWhenReady && !outdated()) {
            enterWhenReady = false;
            if (active >= 0) choose(active);
        }
    }

    function onKey(event) {
        const rows = list.querySelectorAll(".pick-row").length;
        switch (event.key) {
            case "Escape":
                event.preventDefault();
                event.stopPropagation();
                close();
                break;
            case "ArrowDown":
                event.preventDefault();
                setActive(active + 1);
                break;
            case "ArrowUp":
                event.preventDefault();
                setActive(active - 1);
                break;
            case "Home":
                if (!input) {
                    event.preventDefault();
                    setActive(0);
                }
                break;
            case "End":
                if (!input) {
                    event.preventDefault();
                    setActive(rows - 1);
                }
                break;
            case "Enter":
                event.preventDefault();
                if (event.target instanceof HTMLButtonElement) event.target.click();
                else if (outdated()) enterWhenReady = query !== "";
                else if (active >= 0) choose(active);
                break;
            case " ":
                if (!input && event.target === list && active >= 0) {
                    event.preventDefault();
                    choose(active);
                }
                break;
            case "Tab":
                close();
                break;
            default:
        }
    }

    const onDown = (event) => {
        if (pop.contains(event.target) || anchor.contains(event.target)) return;
        close({ restoreFocus: false });
    };
    // Esc closes the picker even when focus has left it (the picker's own handler covers the focused case).
    const onEscape = (event) => {
        if (event.key !== "Escape" || event.defaultPrevented || pop.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };
    const onScroll = (event) => {
        if (!pop.contains(event.target)) close({ restoreFocus: false });
    };

    function close({ restoreFocus = true } = {}) {
        if (closed) return;
        closed = true;
        search.cancel();
        seq++;
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onEscape, true);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", place);
        const hadFocus = pop.contains(document.activeElement);
        pop.remove();
        if (current === handle) current = null;
        anchor.setAttribute("aria-expanded", "false");
        if (restoreFocus && (hadFocus || document.activeElement === document.body) && anchor.isConnected) anchor.focus({ preventScroll: true });
        if (multi && !immediate) {
            const same = picked.size === initial.size && [...picked].every((value) => initial.has(value));
            if (!same) config.onSelect?.([...picked]);
        }
        config.onClose?.();
    }

    const handle = { anchor, close };
    current = handle;
    anchor.setAttribute("aria-haspopup", "listbox");
    anchor.setAttribute("aria-expanded", "true");
    layer.append(pop);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);

    if (isAsync) {
        load("");
    } else {
        shown = filterStatic();
        const chosen = shown.findIndex(isOn);
        active = chosen >= 0 ? chosen : shown.length ? 0 : -1;
    }
    paint();
    if (!isAsync) {
        const chosen = shown.findIndex(isOn);
        if (chosen >= 0) setActive(chosen);
    }
    (input ?? list).focus({ preventScroll: true });
    return handle;
}

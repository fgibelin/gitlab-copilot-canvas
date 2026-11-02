// Tiny DOM toolkit: element builder, inline icons, formatting helpers. Everything is built with DOM APIs and
// text nodes, never HTML strings, so work-item content can never become markup.
const SVG_NS = "http://www.w3.org/2000/svg";
const PROPERTY_KEYS = new Set(["value", "checked", "disabled", "hidden", "draggable", "selected", "readOnly", "tabIndex", "multiple", "open", "indeterminate"]);
const SAFE_URL = /^(https?:|mailto:)/i;

export const isSafeUrl = (value) => SAFE_URL.test(String(value ?? ""));

function append(parent, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false || child === true) continue;
        if (Array.isArray(child)) append(parent, child);
        else if (child instanceof Node) parent.append(child);
        else parent.append(document.createTextNode(String(child)));
    }
}

/** h("div", { class: "x", onclick }, "text", childNode, ...) */
export function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "dataset") Object.assign(el.dataset, value);
        else if (key === "style" && typeof value === "object") for (const [name, v] of Object.entries(value)) el.style.setProperty(name, String(v));
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
        else if ((key === "href" || key === "src") && !isSafeUrl(value)) continue;
        else if (PROPERTY_KEYS.has(key)) el[key] = value;
        else el.setAttribute(key, value === true ? "" : String(value));
    }
    append(el, children);
    return el;
}

export const clear = (el) => el.replaceChildren();

/** Replaces all children like replaceChildren(), but skips null/false/undefined the way h() does (the native call would add the text "null"). */
export function setChildren(parent, ...children) {
    parent.replaceChildren();
    append(parent, children);
}

// ---- icons (16x16, stroke based) ---------------------------------------------------------------------------------
const dot = (cx, cy) => ["circle", { cx, cy, r: 0.9, fill: "currentColor", stroke: "none" }];
const ICONS = {
    plus: [["path", { d: "M8 3v10M3 8h10" }]],
    x: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
    refresh: [["path", { d: "M13 8a5 5 0 1 1-1.6-3.7M13 2.8V6h-3.2" }]],
    search: [["circle", { cx: 7, cy: 7, r: 4.3 }], ["path", { d: "M10.3 10.3L13.5 13.5" }]],
    chevron: [["path", { d: "M4 6.2l4 4 4-4" }]],
    check: [["path", { d: "M3.5 8.5l3 3 6-6.5" }]],
    "issue-open": [["circle", { cx: 8, cy: 8, r: 6 }], ["circle", { cx: 8, cy: 8, r: 1.6, fill: "currentColor", stroke: "none" }]],
    "issue-closed": [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M5.4 8.2l1.8 1.8 3.4-3.7" }]],
    comment: [["path", { d: "M3 3.5h10v7H8.2L5 13v-2.5H3z" }]],
    calendar: [["rect", { x: 2.5, y: 3.5, width: 11, height: 10, rx: 1.6 }], ["path", { d: "M2.5 6.6h11M5.6 2v3M10.4 2v3" }]],
    link: [["path", { d: "M6.6 9.4l2.8-2.8M5.2 8L4 9.2a2.4 2.4 0 0 0 3.4 3.4L8.6 11.4M10.8 8L12 6.8a2.4 2.4 0 0 0-3.4-3.4L7.4 4.6" }]],
    external: [["path", { d: "M9 3h4v4M13 3L7.6 8.4M11 9.6V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.4" }]],
    session: [["rect", { x: 2, y: 2.8, width: 12, height: 10.4, rx: 1.8 }], ["path", { d: "M5.2 6.2L7.2 8l-2 1.8M8.8 10h2.6" }]],
    pencil: [["path", { d: "M3 13l.7-2.9 7-7a1.4 1.4 0 0 1 2 0l.2.2a1.4 1.4 0 0 1 0 2l-7 7zM9.6 4.4l2 2" }]],
    list: [["path", { d: "M5.6 4h8M5.6 8h8M5.6 12h8" }], dot(2.6, 4), dot(2.6, 8), dot(2.6, 12)],
    board: [["rect", { x: 2.5, y: 3, width: 3, height: 10, rx: 0.8 }], ["rect", { x: 6.5, y: 3, width: 3, height: 6, rx: 0.8 }], ["rect", { x: 10.5, y: 3, width: 3, height: 8, rx: 0.8 }]],
    tag: [["path", { d: "M2.5 8.4V3.4h5l6 6-5 5z" }], dot(5.4, 6.2)],
    person: [["circle", { cx: 8, cy: 5.4, r: 2.5 }], ["path", { d: "M3 13.6c.5-3 2.7-4.4 5-4.4s4.5 1.4 5 4.4" }]],
    milestone: [["path", { d: "M4 13.6V2.4M4 3h7.4l-1.6 2.6L11.4 8H4" }]],
    clock: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 4.6V8l2.4 1.5" }]],
    lock: [["rect", { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.3 }], ["path", { d: "M5.6 7V5.6a2.4 2.4 0 0 1 4.8 0V7" }]],
    alert: [["path", { d: "M8 2.6l6 10.4H2z" }], ["path", { d: "M8 6.6v3M8 11.1h.01" }]],
    up: [["path", { d: "M8 13V3.2M4 7l4-3.8L12 7" }]],
    back: [["path", { d: "M13 8H3.2M7 4L3.2 8 7 12" }]],
    child: [["path", { d: "M4 2.6V10a2 2 0 0 0 2 2h6.4M10 9.5l2.6 2.5-2.6 2.5" }]],
    filter: [["path", { d: "M2.6 3.4h10.8L9.6 8.4v4.2l-3.2-1.6V8.4z" }]],
    sort: [["path", { d: "M5 3v10M2.6 10.6L5 13l2.4-2.4M11 13V3M8.6 5.4L11 3l2.4 2.4" }]],
    group: [["rect", { x: 2.5, y: 2.5, width: 11, height: 4, rx: 1 }], ["rect", { x: 2.5, y: 9.5, width: 11, height: 4, rx: 1 }]],
    task: [["rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2 }], ["path", { d: "M5.4 8.2l1.8 1.8 3.4-3.7" }]],
    bug: [["path", { d: "M8 5c-2 0-3 1.3-3 3v1.4C5 11.6 6.3 13 8 13s3-1.4 3-3.6V8c0-1.7-1-3-3-3zM6.4 5a1.7 1.7 0 0 1 3.2 0M2.6 8.4H5M11 8.4h2.4M3.4 5.2L5.2 6.6M12.6 5.2l-1.8 1.4M3.4 12l1.9-1.4M12.6 12l-1.9-1.4" }]],
    grip: [["path", { d: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01", "stroke-width": 2 }]],
    block: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M3.8 12.2l8.4-8.4" }]],
    more: [["circle", { cx: 3.4, cy: 8, r: 1.15, fill: "currentColor", stroke: "none" }], ["circle", { cx: 8, cy: 8, r: 1.15, fill: "currentColor", stroke: "none" }], ["circle", { cx: 12.6, cy: 8, r: 1.15, fill: "currentColor", stroke: "none" }]],
};
const TYPE_ICON = { issue: "issue-open", task: "task", incident: "alert", ticket: "comment", epic: "milestone", objective: "milestone", "key result": "milestone", requirement: "task", "test case": "task" };

export function icon(name, { size = 16, cls = "" } = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("class", `icon ${cls}`.trim());
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ICONS[name] ?? []) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
        svg.append(node);
    }
    return svg;
}

export const typeIcon = (typeName, opts) => icon(TYPE_ICON[String(typeName ?? "").toLowerCase()] ?? "issue-open", opts);
export const stateIcon = (state, opts = {}) => icon(state === "closed" ? "issue-closed" : "issue-open", { ...opts, cls: `state-${state} ${opts.cls ?? ""}`.trim() });

// ---- formatting ---------------------------------------------------------------------------------------------------
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3600], ["minute", 60]];

export function relTime(iso, now = Date.now()) {
    const time = Date.parse(iso ?? "");
    if (Number.isNaN(time)) return "";
    const seconds = (time - now) / 1000;
    for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    return "just now";
}

export const fullTime = (iso) => {
    const time = new Date(iso ?? "");
    return Number.isNaN(time.getTime()) ? "" : time.toLocaleString();
};

const parseDay = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

export function dayLabel(ymd) {
    const day = parseDay(ymd);
    if (!day) return "";
    const sameYear = day.getFullYear() === new Date().getFullYear();
    return day.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "overdue" | "soon" (within 2 days) | "" for a YYYY-MM-DD due date. */
export function dueStatus(ymd, state) {
    const day = parseDay(ymd);
    if (!day || state === "closed") return "";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((day - today) / 86_400_000);
    return days < 0 ? "overdue" : days <= 2 ? "soon" : "";
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function debounce(fn, ms) {
    let timer;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

// ---- small shared widgets -----------------------------------------------------------------------------------------
const COLOR = /^#[0-9a-f]{3,8}$/i;
const safeColor = (value, fallback) => (COLOR.test(String(value ?? "")) ? value : fallback);

export function labelChip(label) {
    const style = { "--lc": safeColor(label.color, "#808080"), "--lt": safeColor(label.textColor, "#ffffff") };
    if (label.scope) {
        return h("span", { class: "chip scoped", style, title: label.description || label.title }, h("span", { class: "chip-scope" }, label.scope), h("span", { class: "chip-value" }, label.value));
    }
    return h("span", { class: "chip", style, title: label.description || label.title }, h("span", { class: "chip-text" }, label.title));
}

function initials(user) {
    const words = String(user.name || user.username || "?").trim().split(/\s+/);
    return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words.at(-1)[0] : "")).toUpperCase();
}

export function avatar(user, size = 20) {
    let hue = 0;
    for (const ch of String(user.username ?? "")) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    const wrap = h("span", { class: "avatar", style: { "--size": `${size}px`, "--hue": hue }, title: user.name && user.name !== user.username ? `${user.name} (@${user.username})` : `@${user.username}` }, h("span", { class: "avatar-fallback" }, initials(user)));
    if (isSafeUrl(user.avatarUrl) && !/^mailto:/i.test(user.avatarUrl)) {
        const img = h("img", { src: user.avatarUrl, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
        img.addEventListener("error", () => img.remove());
        wrap.append(img);
    }
    return wrap;
}

export function avatarStack(users, { size = 20, max = 3 } = {}) {
    const shown = users.slice(0, max);
    return h("span", { class: "avatar-stack" }, shown.map((u) => avatar(u, size)), users.length > max ? h("span", { class: "avatar more", style: { "--size": `${size}px` } }, `+${users.length - max}`) : null);
}

export function toast(message, kind = "info", ms = 4500) {
    const host = document.getElementById("toasts");
    if (!host) return;
    const failed = kind === "error";
    const node = h(
        "div",
        { class: `toast ${kind}`, role: failed ? "alert" : null },
        failed ? icon("alert", { size: 14, cls: "toast-icon" }) : null,
        h("span", {}, String(message).slice(0, 400)),
        h("button", { class: "toast-close", type: "button", "aria-label": "Dismiss", onclick: () => node.remove() }, icon("x", { size: 12 })),
    );
    host.append(node);
    while (host.children.length > 4) host.firstChild.remove();
    if (ms) setTimeout(() => node.remove(), ms);
}

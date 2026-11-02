// Merge request workspace: searchable list, detail, editing, discussion, approval and merge actions.
import { api } from "./api.js";
import { fullTime, h, icon, relTime, setChildren, toast } from "./dom.js";
import { renderMarkdown } from "./md.js";
import { markdownEditor } from "./editor.js";
import { on, state } from "./state.js";

const STATES = [["opened", "Open"], ["merged", "Merged"], ["closed", "Closed"], ["all", "All"]];

export function mountMergeRequests(root) {
    let items = [];
    let selected = null;
    let detail = null;
    let status = "opened";
    let search = "";
    let loading = false;
    let loadingMore = false;
    let hasNextPage = false;
    let nextPage = null;
    let error = null;
    let requestSeq = 0;
    let loadedProject = "";
    let hasLoaded = false;
    let detailSeq = 0;

    const searchInput = h("input", { class: "search-input", type: "search", placeholder: "Search merge requests…", "aria-label": "Search merge requests", autocomplete: "off" });
    const stateSelect = h("select", { class: "input", "aria-label": "Merge request state", onchange: () => { status = stateSelect.value; load(); } }, STATES.map(([value, label]) => h("option", { value }, label)));
    const refresh = h("button", { class: "icon-btn", type: "button", title: "Refresh merge requests", "aria-label": "Refresh merge requests", onclick: () => load() }, icon("refresh", { size: 15 }));
    const create = h("button", { class: "btn primary", type: "button", onclick: () => openForm() }, icon("plus", { size: 14 }), "New merge request");
    const list = h("section", { class: "mr-list", "aria-label": "Merge requests" });
    const detailPane = h("aside", { class: "mr-detail", "aria-label": "Merge request details", hidden: true });
    const toolbar = h("div", { class: "mr-toolbar" }, searchInput, stateSelect, refresh, create);
    const dialog = h("dialog", { class: "mr-dialog", "aria-labelledby": "mr-dialog-title" });
    root.classList.add("merge-workspace");
    setChildren(root, toolbar, h("div", { class: "mr-layout" }, list, detailPane), dialog);

    let searchTimer;
    searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            search = searchInput.value.trim();
            load();
        }, 280);
    });

    function currentProject() {
        return state.project ? `${state.project.host}/${state.project.path}` : "";
    }

    async function load({ more = false } = {}) {
        if (state.phase !== "ready") return;
        if (more && (!hasNextPage || loadingMore)) return;
        const project = currentProject();
        if (!project) return;
        if (loadedProject !== project) {
            loadedProject = project;
            hasLoaded = false;
            status = "opened";
            search = "";
            stateSelect.value = status;
            searchInput.value = "";
            selected = null;
            detail = null;
        }
        const seq = ++requestSeq;
        if (more) loadingMore = true;
        else {
            loading = true;
            loadingMore = false;
            hasNextPage = false;
            nextPage = null;
        }
        error = null;
        paintList();
        try {
            const page = await api.mergeRequests({ state: status, search }, { first: 50, page: more ? nextPage : 1 });
            if (seq !== requestSeq) return;
            items = more ? [...items, ...page.items.filter((mr) => !items.some((item) => item.iid === mr.iid))] : page.items;
            hasNextPage = page.hasNextPage;
            nextPage = page.nextPage;
            hasLoaded = true;
            if (selected !== null) {
                const row = items.find((item) => item.iid === selected);
                if (!row) {
                    selected = null;
                    detail = null;
                } else if (detail) detail = { ...detail, ...row };
            }
        } catch (failure) {
            if (seq === requestSeq) error = failure;
        } finally {
            if (seq === requestSeq) {
                loading = false;
                loadingMore = false;
                paintList();
                paintDetail();
            }
        }
    }

    async function loadDetail(iid) {
        const seq = ++detailSeq;
        selected = iid;
        detail = null;
        paintList();
        paintDetail();
        try {
            const result = await api.mergeRequest(iid);
            if (seq === detailSeq) {
                detail = result;
                paintDetail();
            }
        } catch (failure) {
            if (seq === detailSeq) {
                detail = { error: failure };
                paintDetail();
            }
        }
    }

    function paintList() {
        if (loading && !items.length) {
            setChildren(list, h("p", { class: "mr-empty" }, "Loading merge requests…"));
            return;
        }
        if (error && !items.length) {
            setChildren(list, h("div", { class: "mr-empty mr-error", role: "alert" }, error.message, h("button", { class: "btn", type: "button", onclick: () => load() }, "Retry")));
            return;
        }
        if (!items.length) {
            setChildren(list, h("div", { class: "mr-empty" }, h("h2", {}, error ? "Could not refresh merge requests" : "No merge requests found"), h("p", {}, error?.message ?? (search ? "Try a different search or state filter." : "Create a merge request to propose changes.")), error ? h("button", { class: "btn", type: "button", onclick: () => load() }, "Retry") : null));
            return;
        }
        setChildren(list,
            error ? h("div", { class: "mr-inline-error", role: "alert" }, `Could not refresh: ${error.message}`) : null,
            ...items.map((mr) => h("button", {
                class: `mr-row${mr.iid === selected ? " selected" : ""}`,
                type: "button",
                "aria-current": mr.iid === selected ? "true" : null,
                onclick: () => loadDetail(mr.iid),
            },
            h("div", { class: "mr-row-top" }, h("strong", {}, mr.title), h("span", { class: `mr-state mr-state-${mr.state}` }, mr.draft ? "Draft" : mr.state),),
            h("div", { class: "mr-row-meta" }, `!${mr.iid}`, ` · ${mr.sourceBranch} → ${mr.targetBranch}`, mr.updatedAt ? ` · updated ${relTime(mr.updatedAt)}` : ""),
            )),
            hasNextPage ? h("div", { class: "more" }, h("button", { class: "btn", type: "button", disabled: loadingMore, onclick: () => load({ more: true }) }, loadingMore ? "Loading…" : `Load more merge requests`)) : null,
        );
    }

    function baseUrl() {
        return state.meta?.project?.webUrl ? `${state.meta.project.webUrl.replace(/\/$/, "")}/` : null;
    }

    function openGitLabLink(mr) {
        return mr.webUrl && /^https?:\/\//i.test(mr.webUrl)
            ? h("a", { class: "icon-btn", href: mr.webUrl, target: "_blank", rel: "noopener noreferrer", title: "Open in GitLab", "aria-label": "Open in GitLab" }, icon("external", { size: 15 }))
            : null;
    }

    function renderNotes(mr) {
        const notes = mr.discussions ?? [];
        return notes.length ? notes.map((note) => h("article", { class: "note" },
            h("header", { class: "note-head" }, h("strong", {}, note.author?.name ?? note.author?.username ?? "Unknown user"), note.author?.username ? h("span", { class: "muted" }, `@${note.author.username}`) : null, h("span", { class: "muted" }, "·"), h("time", { datetime: note.createdAt ?? "", title: fullTime(note.createdAt) }, relTime(note.createdAt))),
            renderMarkdown(note.body, { base: baseUrl() }),
        )) : [h("p", { class: "d-empty" }, "No comments yet.")];
    }

    function paintDetail() {
        detailPane.hidden = selected === null;
        if (selected === null) {
            setChildren(detailPane);
            return;
        }
        if (!detail) {
            setChildren(detailPane, h("p", { class: "mr-empty" }, "Loading merge request…"));
            return;
        }
        if (detail.error) {
            setChildren(detailPane, h("div", { class: "mr-empty mr-error", role: "alert" }, detail.error.message, h("button", { class: "btn", type: "button", onclick: () => loadDetail(selected) }, "Retry")));
            return;
        }
        const mr = detail;
        const closed = mr.state !== "opened";
        const description = mr.description.trim() ? renderMarkdown(mr.description, { base: baseUrl() }) : h("p", { class: "d-empty" }, "No description yet.");
        const comments = markdownEditor({
            label: "Merge request comment",
            placeholder: "Write a comment…",
            rows: 3,
            submitLabel: "Comment",
            renderPreview: (text) => renderMarkdown(text, { base: baseUrl() }),
            onSubmit: async (text) => {
                await api.commentMergeRequest(mr.iid, text);
                await loadDetail(mr.iid);
                toast("Comment added");
            },
        });
        setChildren(detailPane,
            h("header", { class: "mr-detail-head" },
                h("div", {}, h("div", { class: "mr-detail-kicker" }, `Merge request !${mr.iid}`), h("h2", {}, mr.title)),
                h("span", { class: "tb-spacer" }),
                openGitLabLink(mr),
                h("button", { class: "icon-btn", type: "button", title: "Close details", "aria-label": "Close details", onclick: () => { selected = null; detail = null; paintList(); paintDetail(); } }, icon("x", { size: 15 })),
            ),
            h("div", { class: "mr-detail-actions" },
                h("button", { class: "btn small", type: "button", onclick: () => openForm(mr) }, icon("pencil", { size: 13 }), "Edit"),
                h("button", { class: "btn small", type: "button", disabled: closed, onclick: () => mutate(() => api.approveMergeRequest(mr.iid), "Merge request approved") }, "Approve"),
                h("button", { class: "btn small", type: "button", disabled: closed, onclick: () => mutate(() => api.updateMergeRequest(mr.iid, { state: "closed" }), "Merge request closed") }, "Close"),
                mr.state === "closed" ? h("button", { class: "btn small", type: "button", onclick: () => mutate(() => api.updateMergeRequest(mr.iid, { state: "opened" }), "Merge request reopened") }, "Reopen") : null,
                mr.state === "opened" ? h("button", { class: "btn primary small", type: "button", onclick: () => merge(mr) }, "Merge now") : null,
                mr.state === "opened" ? h("button", { class: "btn small", type: "button", onclick: () => merge(mr, true) }, "Merge when pipeline succeeds") : null,
            ),
            h("div", { class: "mr-detail-body" },
                h("div", { class: "mr-branches" }, h("code", {}, mr.sourceBranch), h("span", {}, "→"), h("code", {}, mr.targetBranch)),
                mr.mergeStatus ? h("p", { class: "mr-merge-status" }, `Merge status: ${mr.mergeStatus.replaceAll("_", " ")}`) : null,
                h("section", { class: "d-section" }, h("h3", {}, "Description"), description),
                h("section", { class: "d-section" }, h("h3", {}, "Discussion", mr.discussions?.length ? h("span", { class: "d-count" }, String(mr.discussions.length)) : null), h("div", { class: "notes" }, renderNotes(mr)), h("div", { class: "composer" }, comments.el)),
                h("footer", { class: "mr-footer" }, mr.author ? `Created by ${mr.author.name || mr.author.username}` : "Merge request", mr.updatedAt ? ` · updated ${fullTime(mr.updatedAt)}` : ""),
            ),
        );
    }

    async function mutate(work, message) {
        try {
            await work();
            toast(message);
            await load();
            if (selected !== null) await loadDetail(selected);
        } catch (failure) {
            toast(failure.message ?? String(failure), "error", 7000);
        }
    }

    async function merge(mr, whenPipelineSucceeds = false) {
        const action = whenPipelineSucceeds ? "Queue the merge" : "Merge";
        const timing = whenPipelineSucceeds ? "when its pipeline succeeds" : "now";
        if (!window.confirm(`${action} !${mr.iid} “${mr.title}” into ${mr.targetBranch} ${timing}? This changes the target branch.`)) return;
        await mutate(() => api.mergeMergeRequest(mr.iid, { mergeWhenPipelineSucceeds: whenPipelineSucceeds }), whenPipelineSucceeds ? "Merge queued" : "Merge request merged");
    }

    function openForm(existing = null) {
        const title = h("input", { class: "input", type: "text", required: true, maxlength: 255, "aria-label": "Title", value: existing?.title ?? "" });
        const source = h("input", { class: "input", type: "text", required: true, "aria-label": "Source branch", value: existing?.sourceBranch ?? "" });
        const target = h("input", { class: "input", type: "text", required: true, "aria-label": "Target branch", value: existing?.targetBranch ?? "" });
        const description = h("textarea", { class: "ed-input", rows: 7, "aria-label": "Description" });
        description.value = existing?.description ?? "";
        const labels = h("input", { class: "input", type: "text", "aria-label": "Labels", placeholder: "comma, separated, labels", value: (existing?.labels ?? []).join(", ") });
        const draft = h("input", { type: "checkbox", checked: existing?.draft ?? false, "aria-label": "Draft merge request" });
        const error = h("div", { class: "ed-error", role: "alert", hidden: true });
        const save = h("button", { class: "btn primary", type: "submit" }, existing ? "Save changes" : "Create merge request");
        const cancel = h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel");
        const field = (label, input) => h("label", { class: "mr-field" }, h("span", {}, label), input);
        const form = h("form", { class: "mr-form", onsubmit: async (event) => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            save.disabled = true;
            error.hidden = true;
            const data = {
                title: title.value,
                targetBranch: target.value.trim(),
                description: description.value,
                labels: labels.value.split(",").map((label) => label.trim()).filter(Boolean),
                draft: draft.checked,
            };
            try {
                const result = existing
                    ? await api.updateMergeRequest(existing.iid, data)
                    : await api.createMergeRequest({ ...data, sourceBranch: source.value.trim() });
                dialog.close();
                toast(existing ? "Merge request updated" : `Merge request !${result.iid} created`);
                status = "opened";
                stateSelect.value = status;
                search = "";
                searchInput.value = "";
                await load();
                await loadDetail(result.iid);
            } catch (failure) {
                error.textContent = failure.message ?? String(failure);
                error.hidden = false;
                save.disabled = false;
            }
        } },
        h("div", { class: "mr-dialog-head" }, h("h2", { id: "mr-dialog-title" }, existing ? `Edit !${existing.iid}` : "New merge request"), h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: () => dialog.close() }, icon("x", { size: 15 }))),
        field("Title", title),
        existing ? null : field("Source branch", source),
        field("Target branch", target),
        field("Description", description),
        field("Labels", labels),
        h("label", { class: "check" }, draft, h("span", {}, "Draft")),
        error,
        h("div", { class: "ed-actions" }, cancel, save));
        setChildren(dialog, form);
        dialog.showModal();
        title.focus();
    }

    function render() {
        const active = state.domain === "merge_requests" && state.phase === "ready";
        if (!active) return;
        if (loadedProject !== currentProject() || (!hasLoaded && !loading && !error)) load();
        paintList();
        paintDetail();
    }

    function closeDetail() {
        if (selected === null) return false;
        selected = null;
        detail = null;
        paintList();
        paintDetail();
        return true;
    }

    on("phase", render);
    on("domain", render);
    on("changed", () => {
        if (state.domain === "merge_requests") load();
    });

    return { render, closeDetail, create: () => openForm(), refresh: () => load(), focusSearch: () => searchInput.focus() };
}

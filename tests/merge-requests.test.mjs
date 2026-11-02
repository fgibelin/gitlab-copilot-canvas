import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../gitlab-copilot-canvas/gitlab.mjs";

const row = {
    iid: 42,
    title: "Add merge request support",
    description: "A description",
    state: "opened",
    web_url: "https://gitlab.example.com/group/project/-/merge_requests/42",
    created_at: "2026-10-30T12:00:00Z",
    updated_at: "2026-10-31T12:00:00Z",
    source_branch: "feature/mr-support",
    target_branch: "main",
    draft: false,
    detailed_merge_status: "mergeable",
    author: { id: 1, username: "alice", name: "Alice", avatar_url: "/uploads/alice.png", web_url: "/alice" },
    assignees: [],
    reviewers: [],
    labels: ["feature"],
    user_notes_count: 0,
};

function fixture() {
    const calls = [];
    const service = createService({
        host: "gitlab.example.com",
        projectPath: "group/project",
        run: async (args, { stdin }) => {
            calls.push({ args, body: stdin ? JSON.parse(stdin) : undefined });
            const endpoint = args[1];
            let result = row;
            if (endpoint.startsWith("projects/group%2Fproject/merge_requests?")) result = [row];
            else if (endpoint.includes("/notes")) result = endpoint.includes("?") ? [] : { id: 7, body: "A note", created_at: "2026-11-01T10:00:00Z", author: row.author };
            else if (endpoint.endsWith("/approve")) result = { approved: true };
            else if (endpoint.endsWith("/merge")) result = { ...row, state: "merged", merged_at: "2026-11-01T12:00:00Z" };
            return { code: 0, stdout: JSON.stringify(result), stderr: "" };
        },
    });
    return { calls, service };
}

test("lists and normalizes merge requests with encoded project paths", async () => {
    const { calls, service } = fixture();
    const page = await service.listMergeRequests({ state: "opened", search: "branch support" }, { first: 20, page: 2 });
    assert.equal(page.total, null);
    assert.equal(page.items[0].iid, 42);
    assert.equal(page.hasNextPage, false);
    assert.equal(page.nextPage, null);
    assert.equal(page.items[0].author.avatarUrl, "https://gitlab.example.com/uploads/alice.png");
    assert.equal(page.items[0].author.webUrl, "https://gitlab.example.com/alice");
    assert.match(calls[0].args[1], /^projects\/group%2Fproject\/merge_requests\?/);
    assert.match(calls[0].args[1], /search=branch\+support/);
    assert.match(calls[0].args[1], /per_page=20/);
    assert.match(calls[0].args[1], /page=2/);
});

test("creates and updates merge requests with REST payloads", async () => {
    const { calls, service } = fixture();
    await service.createMergeRequest({ title: "New MR", sourceBranch: "feature/new", targetBranch: "main", draft: true, labels: ["one", "two"] });
    assert.equal(calls[0].args[2], "--hostname");
    assert.equal(calls[0].args[calls[0].args.indexOf("--method") + 1], "POST");
    assert.deepEqual(calls[0].body, { title: "New MR", source_branch: "feature/new", target_branch: "main", draft: true, labels: "one,two" });

    await service.updateMergeRequest(42, { state: "closed", targetBranch: "stable", labels: [] });
    assert.equal(calls[1].args[calls[1].args.indexOf("--method") + 1], "PUT");
    assert.deepEqual(calls[1].body, { target_branch: "stable", labels: "", state_event: "close" });
});

test("comments, approvals, and merges use the correct GitLab endpoints", async () => {
    const { calls, service } = fixture();
    const note = await service.commentMergeRequest(42, "Review comment");
    assert.equal(note.body, "A note");
    assert.equal(calls[0].args[1], "projects/group%2Fproject/merge_requests/42/notes");
    assert.deepEqual(calls[0].body, { body: "Review comment" });

    await service.approveMergeRequest(42);
    assert.match(calls[1].args[1], /\/approve$/);
    assert.equal(calls[1].args[calls[1].args.indexOf("--method") + 1], "POST");

    const merged = await service.mergeMergeRequest(42, { mergeWhenPipelineSucceeds: true, shouldRemoveSourceBranch: true });
    assert.equal(merged.state, "merged");
    assert.match(calls[4].args[1], /\/merge$/);
    assert.deepEqual(calls[4].body, { merge_when_pipeline_succeeds: true, should_remove_source_branch: true });
});

test("rejects invalid merge request numbers, branches, labels and empty notes before calling GitLab", async () => {
    const { calls, service } = fixture();
    await assert.rejects(service.listMergeRequests({}, { first: 1.5 }), { code: "invalid" });
    await assert.rejects(service.getMergeRequest(0), { code: "invalid" });
    await assert.rejects(service.createMergeRequest({ title: "No branch", sourceBranch: "", targetBranch: "main" }), { code: "invalid" });
    await assert.rejects(service.createMergeRequest({ title: "Too many labels", sourceBranch: "feature/a", targetBranch: "main", labels: Array.from({ length: 51 }, (_, i) => `label-${i}`) }), { code: "invalid" });
    await assert.rejects(service.commentMergeRequest(42, "  "), { code: "invalid" });
    assert.equal(calls.length, 0);
});

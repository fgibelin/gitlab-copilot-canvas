import assert from "node:assert/strict";
import test from "node:test";
import { createService, DOCS } from "../canvas/gitlab.mjs";

function fixture() {
    const mutations = [];
    const type = { id: "gid://gitlab/WorkItems::Type/1", name: "Issue" };
    const project = { id: "gid://gitlab/Project/1", workItemTypes: { nodes: [type] } };
    const item = { id: "gid://gitlab/WorkItem/1", iid: "1", title: "Test", state: "OPEN", workItemType: type };
    const service = createService({
        host: "gitlab.example.com",
        projectPath: "test/project",
        run: async (_args, { stdin }) => {
            const { query, variables } = JSON.parse(stdin);
            let data;
            if (query === DOCS.meta || query === DOCS.typeRules) data = { project };
            else if (query === DOCS.idLookup) data = { project: { ...project, workItems: { nodes: [item] } } };
            else if (query === DOCS.create || query === DOCS.update) {
                mutations.push(variables.input);
                data = { [query === DOCS.create ? "workItemCreate" : "workItemUpdate"]: { errors: [], workItem: item } };
            } else assert.fail("Unexpected GraphQL operation");
            return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
        },
    });
    return { service, mutations };
}

for (const [name, dates, expected] of [
    ["omitted dates", {}, undefined],
    ["empty dates", { startDate: "", dueDate: "" }, undefined],
    ["null dates", { startDate: null, dueDate: null }, undefined],
    ["start date only", { startDate: "2028-02-29" }, { startDate: "2028-02-29" }],
    ["due date only", { dueDate: "2026-11-30" }, { dueDate: "2026-11-30" }],
    ["both dates", { startDate: "2026-11-01", dueDate: "2026-11-30" }, { startDate: "2026-11-01", dueDate: "2026-11-30" }],
]) {
    test(`create accepts ${name}`, async () => {
        const { service, mutations } = fixture();
        await service.create({ title: "Test", ...dates });
        assert.equal(mutations.length, 1);
        assert.deepEqual(mutations[0].startAndDueDateWidget, expected);
    });
}

for (const date of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-1-01", "tomorrow"]) {
    test(`create and update reject invalid date ${date} before mutating`, async () => {
        const { service, mutations } = fixture();
        await assert.rejects(service.create({ title: "Test", dueDate: date }), { code: "invalid" });
        await assert.rejects(service.update(1, { startDate: date }), { code: "invalid" });
        assert.equal(mutations.length, 0);
    });
}

test("update preserves omitted dates and clears only an explicitly empty date", async () => {
    const { service, mutations } = fixture();
    await service.update(1, { title: "Renamed" });
    assert.equal(mutations[0].startAndDueDateWidget, undefined);
    await service.update(1, { dueDate: "" });
    assert.deepEqual(mutations[1].startAndDueDateWidget, { dueDate: null });
});

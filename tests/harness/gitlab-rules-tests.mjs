// Unit tests for the work item type rules in the data layer. Run: node gitlab-rules-tests.mjs
import { createService, normalizeTypeRules } from "../../canvas/gitlab.mjs";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) pass++;
    else {
        fail++;
        console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`);
    }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const names = (list) => ({ nodes: list.map((name) => ({ name })) });
const hier = (children, parents) => ({ type: "HIERARCHY", allowedChildTypes: names(children), allowedParentTypes: names(parents) });
const labels = (allowsScopedLabels) => ({ type: "LABELS", allowsScopedLabels });
const typeNode = (name, widgetDefinitions) => ({ name, widgetDefinitions });
const wrap = (nodes) => ({ project: { id: "gid://gitlab/Project/1", workItemTypes: { nodes } } });

// ---- normalizeTypeRules --------------------------------------------------------------------------------------------------------
{
    const data = wrap([
        typeNode("Issue", [{ type: "ASSIGNEES" }, hier(["Task"], []), labels(false)]),
        typeNode("Task", [hier([], ["Issue", "Incident", "Ticket"]), labels(false)]),
        typeNode("Incident", [hier(["Task"], []), labels(false)]),
        typeNode("Ticket", [hier(["Task"], ["Epic"]), labels(false)]),
    ]);
    const rules = normalizeTypeRules(data);
    check("each type gets its own rule", same(rules.byName.get("Issue"), { childTypes: ["Task"], parentTypes: [] }) && same(rules.byName.get("Task"), { childTypes: [], parentTypes: ["Issue", "Incident", "Ticket"] }));
    check("types the project does not have (Epic) are dropped", same(rules.byName.get("Ticket"), { childTypes: ["Task"], parentTypes: [] }), JSON.stringify(rules.byName.get("Ticket")));
    check("scoped labels false when every type says false", rules.scoped === false, String(rules.scoped));
}
{
    const rules = normalizeTypeRules(wrap([typeNode("Issue", [labels(false)]), typeNode("Task", [labels(true)])]));
    check("scoped labels true when any type allows them", rules.scoped === true);
    check("no hierarchy widget -> no rule for the type", rules.byName.size === 0);
}
{
    const rules = normalizeTypeRules(wrap([typeNode("Issue", [{ type: "ASSIGNEES" }]), typeNode("Task", null)]));
    check("scoped labels unknown when no LABELS definition carries the flag", rules.scoped === null);
    check("tolerates missing and null widgetDefinitions", rules.byName.size === 0);
}
{
    const partial = { type: "HIERARCHY", allowedChildTypes: names(["Task"]) };
    const rules = normalizeTypeRules(wrap([typeNode("Issue", [partial, labels(true)]), typeNode("Task", [hier([], ["Issue"])])]));
    check("a half-answered hierarchy definition is ignored, not read as 'no parents'", !rules.byName.has("Issue") && rules.byName.has("Task"));
}
{
    const rules = normalizeTypeRules(wrap([typeNode("Issue", [null, undefined, hier(["Task"], [])]), typeNode("Task", [])]));
    check("tolerates null widget definition entries", same(rules.byName.get("Issue"), { childTypes: ["Task"], parentTypes: [] }));
}
check("null when there is no data", normalizeTypeRules(null) === null && normalizeTypeRules({}) === null && normalizeTypeRules({ project: null }) === null);
check("null when the project has no types", normalizeTypeRules(wrap([])) === null);

// ---- service.meta() merges the rules; a failing rules query degrades instead of failing -----------------------------------------
const metaResponse = {
    data: {
        currentUser: { id: "gid://gitlab/User/1", username: "feured", name: "F", avatarUrl: null, webUrl: "https://gitlab.com/feured" },
        project: {
            id: "gid://gitlab/Project/1",
            name: "demo",
            fullPath: "acme/demo",
            webUrl: "https://gitlab.com/acme/demo",
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            projectMembers: { nodes: [], pageInfo: { hasNextPage: false } },
            milestones: { nodes: [], pageInfo: { hasNextPage: false } },
            workItemTypes: { nodes: [{ id: "gid://gitlab/WorkItems::Type/1", name: "Issue", iconName: "issue-type-issue" }, { id: "gid://gitlab/WorkItems::Type/5", name: "Task", iconName: "issue-type-task" }] },
        },
    },
};
const rulesResponse = { data: wrap([typeNode("Issue", [hier(["Task"], []), labels(true)]), typeNode("Task", [hier([], ["Issue", "Epic"]), labels(true)])]) };

const serve = (handlers) => {
    const seen = [];
    const run = async (_args, options) => {
        const { query } = JSON.parse(options.stdin);
        seen.push(query);
        const handler = query.includes("WorkItemTypeRules") ? handlers.rules : handlers.meta;
        return handler();
    };
    return { run, seen };
};
const ok = (payload) => () => ({ code: 0, stdout: JSON.stringify(payload), stderr: "" });
const gqlError = (message) => () => ({ code: 0, stdout: JSON.stringify({ errors: [{ message }] }), stderr: "" });
const make = (run) => createService({ host: "gitlab.com", projectPath: "acme/demo", run });

{
    const { run, seen } = serve({ meta: ok(metaResponse), rules: ok(rulesResponse) });
    const meta = await make(run).meta();
    check("meta() sends both queries", seen.length === 2, String(seen.length));
    check("meta() merges the rules into each type", same(meta.types.map((t) => [t.name, t.childTypes, t.parentTypes]), [["Issue", ["Task"], []], ["Task", [], ["Issue"]]]), JSON.stringify(meta.types));
    check("meta() reports scopedLabels", meta.scopedLabels === true);
}
{
    const { run } = serve({ meta: ok(metaResponse), rules: gqlError("Field 'allowedParentTypes' doesn't exist on type 'WorkItemWidgetDefinitionHierarchy'") });
    const meta = await make(run).meta();
    check("a failing rules query degrades to unrestricted", meta.types.length === 2 && meta.types.every((t) => t.childTypes === null && t.parentTypes === null) && meta.scopedLabels === null, JSON.stringify(meta.types));
}
{
    const { run } = serve({ meta: ok(metaResponse), rules: () => ({ code: 1, stdout: "", stderr: "glab: network down" }) });
    const meta = await make(run).meta();
    check("a rules query that cannot even run also degrades", meta.types.length === 2 && meta.scopedLabels === null);
}
{
    const { run } = serve({ meta: gqlError("boom"), rules: ok(rulesResponse) });
    let failure = null;
    try {
        await make(run).meta();
    } catch (error) {
        failure = error;
    }
    check("a failing MAIN meta query still fails loudly", failure !== null && /boom/.test(failure.message), failure?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

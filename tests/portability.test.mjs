import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectProject } from "../canvas/gitlab.mjs";

test("GitHub checkout is not treated as a GitLab project", async () => {
    assert.equal(await detectProject("/example", { git: async () => "origin git@github.com:someone/project.git (fetch)\n" }), null);
});
test("detects GitLab and self-managed projects independently of installation location", async () => {
    for (const host of ["gitlab.com", "code.example.com"]) {
        const project = await detectProject("/other/project", { git: async (args) => {
            assert.deepEqual(args, ["-C", "/other/project", "remote", "-v"]);
            return `origin git@${host}:team/another-project.git (fetch)\n`;
        } });
        assert.deepEqual(project, { remote: "origin", host, path: "team/another-project" });
    }
});
test("installer supports user scope and another repository without overwriting existing files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gitlab-canvas-install-"));
    const script = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
    const home = path.join(root, "copilot-home");
    const repo = path.join(root, "another-project");
    try {
        execFileSync(process.execPath, [script, "--user"], { env: { ...process.env, COPILOT_HOME: home } });
        const target = path.join(home, "extensions/gitlab-work-items");
        assert.match(await readFile(path.join(target, "extension.mjs"), "utf8"), /joinSession/);
        assert.match(await readFile(path.join(target, "LICENSE"), "utf8"), /MIT License/);
        assert.throws(() => execFileSync(process.execPath, [script, "--user"], { env: { ...process.env, COPILOT_HOME: home }, stdio: "pipe" }), /Already installed/);
        await mkdir(repo);
        execFileSync("git", ["init", "--quiet", repo]);
        execFileSync(process.execPath, [script, "--project", repo]);
        assert.equal(JSON.parse(await readFile(path.join(repo, ".github/extensions/gitlab-work-items/copilot-extension.json"), "utf8")).name, "gitlab-work-items");
        assert.throws(() => execFileSync(process.execPath, [script], { stdio: "pipe" }), /Usage/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

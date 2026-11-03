import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("all locked minimatch copies include the globparts amplification fix", async () => {
    const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
    const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith("/minimatch"));
    assert.ok(copies.length > 0);
    for (const [name, { version }] of copies) {
        const [major, minor, patch] = version.split(".").map(Number);
        assert.ok(major > 11 || (major === 11 && (minor > 0 || (minor === 0 && patch >= 1))), `${name}@${version} must be >=11.0.1`);
    }
});

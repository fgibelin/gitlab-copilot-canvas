import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const name of ["http-tests", "extension-tests", "gitlab-rules-tests"]) {
    test(`existing ${name} checks`, () => {
        const args = name === "extension-tests" ? ["--import", new URL("./harness/register.mjs", import.meta.url).href] : [];
        args.push(fileURLToPath(new URL(`./harness/${name}.mjs`, import.meta.url)));
        execFileSync(process.execPath, args, { stdio: "inherit", timeout: 60_000 });
    });
}

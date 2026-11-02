import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
execFileSync("tar", ["-czf", "dist/gitlab-work-items.tar.gz", "-C", ".", "canvas"], { cwd: root, stdio: "inherit" });
console.log("Created dist/gitlab-work-items.tar.gz (extract and install canvas/ as gitlab-work-items/).");

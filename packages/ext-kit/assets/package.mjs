// 通用打包脚本（由 zucker ext sync 分发）：zip 名取自 package.json 的 name + manifest 版本
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// zip 名优先取消费项目 package.json 的 extensionSlug，否则从 name 推导
const slug = pkg.extensionSlug || (pkg.name || "extension").replace(/^@[^/]+\//, "").replace(/-extension$/, "");
const INCLUDE = ["manifest.json", "background.js", "offscreen.html", "offscreen.js", "popup", "lib", "icons"];
const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });
const zipPath = join(distDir, `${slug}-v${manifest.version}.zip`);
rmSync(zipPath, { force: true });
execFileSync("zip", ["-r", "-X", zipPath, ...INCLUDE, "-x", "*.DS_Store"], { cwd: root, stdio: "inherit" });
console.log(`\nPackaged: ${zipPath}`);

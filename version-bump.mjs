import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

// Generate version as YY.MM.DD.HHMM
const now = new Date();
const yy = String(now.getFullYear()).slice(-2);
const mm = String(now.getMonth() + 1).padStart(2, "0");
const dd = String(now.getDate()).padStart(2, "0");
const hhmm = String(now.getHours() * 60 + now.getMinutes()).padStart(4, "0");
const targetVersion = `${yy}.${mm}${dd}.${hhmm}`;

console.log(`Bumping version to ${targetVersion}`);

// update package.json version
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = targetVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, "  ") + "\n");

// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

// stage the changed files so they're included in the build
try {
  execSync("git add package.json manifest.json versions.json", { stdio: "ignore" });
} catch { /* not in git — ignore */ }

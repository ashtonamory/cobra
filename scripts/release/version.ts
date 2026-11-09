// The one version a release carries, in every file that names it.
//
//   node scripts/release/version.ts check 0.4.0   # exit 1, with the files that differ
//   node scripts/release/version.ts set 0.4.0     # write it into each
//
// The release workflow checks the tag against these before it builds: the
// desk's updater compares versions, and a package named one version that
// holds another would confuse install.sh.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VERSION_FILES = [
  "apps/agent/package.json",
  "apps/desk/app/package.json",
  "apps/desk/app/src-tauri/tauri.conf.json",
  "apps/desk/app/src-tauri/Cargo.toml",
] as const;

const SEMVER = /^\d+\.\d+\.\d+$/;
const TOML_VERSION = /^version = "([^"]*)"$/m;
const JSON_VERSION = /^(\s*"version":\s*")([^"]*)(")/m;

/** The version a file names: package.json and tauri.conf.json by their "version", Cargo.toml by its package version. */
export function versionIn(path: string, text: string): string | null {
  const match = path.endsWith(".toml") ? TOML_VERSION.exec(text) : JSON_VERSION.exec(text);
  return match ? (path.endsWith(".toml") ? match[1]! : match[2]!) : null;
}

/** The file with `version` in place of the one it names; only the first, which is the package's own. */
export function withVersion(path: string, text: string, version: string): string {
  return path.endsWith(".toml") ? text.replace(TOML_VERSION, `version = "${version}"`) : text.replace(JSON_VERSION, `$1${version}$3`);
}

/** The files that do not name `version`, each with what it names. */
export function mismatches(read: (path: string) => string, version: string): string[] {
  return VERSION_FILES.flatMap((path) => {
    const found = versionIn(path, read(path));
    return found === version ? [] : [`${path}: ${found ?? "no version"}`];
  });
}

if (import.meta.main) {
  const [action, raw] = process.argv.slice(2);
  const version = (raw ?? "").replace(/^v/, "");
  if ((action !== "check" && action !== "set") || !SEMVER.test(version)) {
    console.error("usage: node scripts/release/version.ts check|set <x.y.z>");
    process.exit(2);
  }
  const root = join(import.meta.dirname, "..", "..");
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  if (action === "set") {
    for (const path of VERSION_FILES) writeFileSync(join(root, path), withVersion(path, read(path), version));
    console.log(`Set ${version} in ${VERSION_FILES.length} files. The desk's Cargo.lock follows at its next build.`);
  } else {
    const wrong = mismatches(read, version);
    if (wrong.length) {
      console.error(`The tag is ${version}, but:\n${wrong.map((line) => `  ${line}`).join("\n")}\nRun: node scripts/release/version.ts set ${version}`);
      process.exit(1);
    }
    console.log(`Every file names ${version}.`);
  }
}

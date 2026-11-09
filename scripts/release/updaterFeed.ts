// The desk's update feed, latest.json, from the release's files.
//
//   node scripts/release/updaterFeed.ts <dir> <version> <owner/repo>
//
// The desk's updater (tauri-plugin-updater) reads it from the latest
// release, downloads the file for its platform, and checks that file
// against its signature (the .sig beside it, made with the release's
// updater key) and the public key built into the app before it installs.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Feed = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/** Which updater platforms a release file serves: the macOS app (one universal build) and each Linux AppImage. */
export function platformsOf(name: string): string[] {
  if (name.endsWith(".app.tar.gz")) return ["darwin-aarch64", "darwin-x86_64"];
  if (/_(amd64|x86_64)\.AppImage$/.test(name)) return ["linux-x86_64"];
  if (/_(aarch64|arm64)\.AppImage$/.test(name)) return ["linux-aarch64"];
  return [];
}

export function feed(files: readonly string[], signature: (name: string) => string, version: string, repo: string, now: Date): Feed {
  const platforms: Feed["platforms"] = {};
  for (const name of files) {
    const serves = platformsOf(name);
    if (serves.length === 0) continue;
    if (!files.includes(`${name}.sig`)) throw new Error(`${name} has no signature (${name}.sig): was the updater key set?`);
    const entry = { signature: signature(`${name}.sig`).trim(), url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}` };
    for (const platform of serves) {
      if (platforms[platform]) throw new Error(`two files for ${platform}`);
      platforms[platform] = entry;
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error("no desk update files in the release");
  return { version, notes: `Cobra ${version}`, pub_date: now.toISOString(), platforms };
}

if (import.meta.main) {
  const [dir, version, repo] = process.argv.slice(2);
  if (!dir || !version || !repo) {
    console.error("usage: node scripts/release/updaterFeed.ts <dir> <version> <owner/repo>");
    process.exit(2);
  }
  const out = feed(readdirSync(dir), (name) => readFileSync(join(dir, name), "utf8"), version, repo, new Date());
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(out.platforms).join(", ")}`);
}

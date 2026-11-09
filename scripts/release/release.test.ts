import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { feed, platformsOf } from "./updaterFeed.ts";
import { mismatches, VERSION_FILES, versionIn, withVersion } from "./version.ts";

const root = join(import.meta.dirname, "..", "..");

test("every version file names a version, and set writes only the package's own", () => {
  for (const path of VERSION_FILES) assert.match(versionIn(path, readFileSync(join(root, path), "utf8")) ?? "", /^\d+\.\d+\.\d+$/, path);
  const cargo = '[package]\nname = "x"\nversion = "0.1.7"\n\n[dependencies]\nfoo = { version = "2" }\n';
  assert.equal(withVersion("Cargo.toml", cargo, "0.4.0"), cargo.replace('version = "0.1.7"', 'version = "0.4.0"'));
  const json = '{\n  "name": "a",\n  "version": "0.1.7",\n  "dependencies": { "b": "1" }\n}\n';
  assert.equal(versionIn("package.json", withVersion("package.json", json, "0.4.0")), "0.4.0");
});

test("a check names each file that differs", () => {
  const texts: Record<string, string> = {
    "apps/agent/package.json": '{\n  "version": "0.4.0"\n}',
    "apps/desk/app/package.json": '{\n  "version": "0.1.7"\n}',
    "apps/desk/app/src-tauri/tauri.conf.json": '{\n  "version": "0.4.0"\n}',
    "apps/desk/app/src-tauri/Cargo.toml": 'version = "0.4.0"',
  };
  assert.deepEqual(mismatches((path) => texts[path]!, "0.4.0"), ["apps/desk/app/package.json: 0.1.7"]);
});

test("the feed: the universal Mac app for both Macs, each AppImage for its Linux", () => {
  assert.deepEqual(platformsOf("Cobra_0.4.0_universal.app.tar.gz"), ["darwin-aarch64", "darwin-x86_64"]);
  assert.deepEqual(platformsOf("Cobra_0.4.0_amd64.AppImage"), ["linux-x86_64"]);
  assert.deepEqual(platformsOf("Cobra_0.4.0_aarch64.AppImage"), ["linux-aarch64"]);
  assert.deepEqual(platformsOf("Cobra_0.4.0_amd64.deb"), []);
  const files = ["Cobra_0.4.0_universal.app.tar.gz", "Cobra_0.4.0_universal.app.tar.gz.sig", "Cobra_0.4.0_amd64.AppImage", "Cobra_0.4.0_amd64.AppImage.sig", "SHA256SUMS"];
  const out = feed(files, (name) => `sig of ${name}\n`, "0.4.0", "owner/cobra", new Date("2026-11-08T00:00:00Z"));
  assert.equal(out.version, "0.4.0");
  assert.equal(out.pub_date, "2026-11-08T00:00:00.000Z");
  assert.deepEqual(Object.keys(out.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "linux-x86_64"]);
  assert.equal(out.platforms["linux-x86_64"]?.signature, "sig of Cobra_0.4.0_amd64.AppImage.sig");
  assert.equal(out.platforms["linux-x86_64"]?.url, "https://github.com/owner/cobra/releases/download/v0.4.0/Cobra_0.4.0_amd64.AppImage");
});

test("an update file with no signature stops the release", () => {
  assert.throws(() => feed(["Cobra_0.4.0_amd64.AppImage"], () => "", "0.4.0", "o/r", new Date()), /no signature/);
  assert.throws(() => feed(["SHA256SUMS"], () => "", "0.4.0", "o/r", new Date()), /no desk update files/);
});

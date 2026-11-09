import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";

import { acceptsGzip, encodeJson, GZIP_MIN_BYTES } from "./compress.ts";

test("gzip is taken when listed or starred, never at q=0 or when not asked", () => {
  assert.equal(acceptsGzip("gzip, deflate, br"), true, "the phone's URLSession");
  assert.equal(acceptsGzip("br;q=1.0, gzip;q=0.8"), true);
  assert.equal(acceptsGzip(["deflate", "gzip"]), true);
  assert.equal(acceptsGzip("*"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false);
  assert.equal(acceptsGzip("*, gzip;q=0"), false);
  assert.equal(acceptsGzip("identity"), false);
  assert.equal(acceptsGzip(""), false, "urllib and curl ask for nothing");
  assert.equal(acceptsGzip(undefined), false);
});

test("a large reply goes gzipped and unpacks to the same JSON; a small one goes plain", () => {
  const big = JSON.stringify({ projects: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, activity: "agent-idle" })) });
  const sent = encodeJson(big, "gzip, deflate, br");
  assert.equal(sent.gzip, true);
  assert.ok(sent.body.length < big.length / 3, `${sent.body.length} of ${big.length} bytes`);
  assert.equal(gunzipSync(sent.body).toString(), big);

  assert.equal(encodeJson(big, undefined).gzip, false);
  const small = JSON.stringify({ ok: true });
  assert.ok(small.length < GZIP_MIN_BYTES);
  assert.deepEqual(encodeJson(small, "gzip"), { body: Buffer.from(small), gzip: false });
});

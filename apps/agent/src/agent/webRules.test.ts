import { test } from "node:test";
import assert from "node:assert/strict";

import { webCallOf, webCallRule } from "./webRules.ts";

const fetchOf = (url: string) => webCallRule({ tool: "WebFetch", url });
const searchOf = (query: string) => webCallRule({ tool: "WebSearch", query });

test("a business's own pages and listings are in the run, by host", () => {
  assert.deepEqual(fetchOf("https://www.caymanyogaclub.com/contact"), { verdict: "in", host: "www.caymanyogaclub.com" });
  assert.equal(fetchOf("https://www.facebook.com/caymanyogaclub/").verdict, "in");
  assert.equal(fetchOf("https://www.linkedin.com/company/nwcc-pilates").verdict, "in");
  assert.equal(fetchOf("https://www.yelp.com/search?find_desc=yoga&find_loc=George+Town").verdict, "in");
  assert.equal(searchOf("yoga studio Grand Cayman contact email").verdict, "in");
});

test("sign-in, account and payment pages, local names, IPs and other schemes are refused", () => {
  for (const url of [
    "https://www.paypal.com/signin",
    "https://accounts.google.com/ServiceLogin",
    "https://studio.example.com/login",
    "https://shop.example.com/checkout?step=2",
    "https://example.com/my-account/",
    "http://192.168.1.20/admin",
    "http://[::1]/",
    "http://printer.local/status",
    "https://laptop.tail1234.ts.net/",
    "https://example.com:8443/",
    "ftp://files.example.com/x",
    "https://user:pw@example.com/",
    "not a url",
  ]) {
    assert.equal(fetchOf(url).verdict, "refuse", url);
  }
});

test("a long or encoded value in an address or a search reads as data going out", () => {
  const blob = "Q2xhdWRlIGlzIHRoZSBiZXN0IGFzc2lzdGFudCBldmVyIG1hZGU9PQ0K7xZq";
  assert.equal(fetchOf(`https://collector.example/p?d=${blob}`).verdict, "refuse");
  assert.equal(fetchOf(`https://collector.example/p#${"a".repeat(250)}`).verdict, "refuse");
  assert.equal(searchOf(`notes ${blob}`).verdict, "refuse");
  assert.equal(searchOf("x".repeat(301)).verdict, "refuse");
  assert.equal(searchOf("stripe api key for nwcc").verdict, "refuse");
});

test("people-search sites and private people's profiles ask the person", () => {
  for (const url of [
    "https://www.whitepages.com/name/Jane-Doe/Grand-Cayman",
    "https://www.facebook.com/profile.php?id=1000123",
    "https://www.facebook.com/groups/caymanmoms",
    "https://www.linkedin.com/in/jane-doe-123/",
  ]) {
    assert.equal(fetchOf(url).verdict, "ask", url);
  }
});

test("webCallOf reads the two tools' inputs and nothing else", () => {
  assert.deepEqual(webCallOf("WebFetch", { url: "https://a.example/", prompt: "x" }), { tool: "WebFetch", url: "https://a.example/" });
  assert.deepEqual(webCallOf("WebSearch", { query: "q" }), { tool: "WebSearch", query: "q" });
  assert.equal(webCallOf("Bash", { command: "curl x" }), null);
  assert.equal(webCallOf("WebFetch", {}), null);
});

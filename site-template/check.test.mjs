import { test } from "node:test";
import assert from "node:assert/strict";

import { judged } from "./check.mjs";

const frame = (url, parent = null) => ({ url: () => url, parentFrame: () => parent });
const request = (from, navigation = false) => ({ frame: () => from, isNavigationRequest: () => navigation });

test("judged: the page's own loads and the frames it opens are judged; loads inside a named service's frame are the service's", () => {
  const main = frame("http://127.0.0.1:4000/contact/");
  const map = frame("https://www.google.com/maps/embed?pb=1", main);
  const inner = frame("https://maps.gstatic.com/inner", map);
  const stranger = frame("https://tracker.example/frame", main);
  assert.equal(judged(request(main), main, ["www.google.com"]), true, "a load by the page");
  assert.equal(judged(request(map, true), main, ["www.google.com"]), true, "the frame the page opens is judged by its own address");
  assert.equal(judged(request(map), main, ["www.google.com"]), false, "the map's tiles and fonts");
  assert.equal(judged(request(inner), main, ["www.google.com"]), false, "a frame inside the map's frame");
  assert.equal(judged(request(stranger), main, ["www.google.com"]), true, "inside a frame of a host the site does not name");
  assert.equal(judged(request(map), main, []), true, "nothing named: everything is judged");
  assert.equal(judged({ frame: () => { throw new Error("service worker"); }, isNavigationRequest: () => false }, main, ["www.google.com"]), true);
});

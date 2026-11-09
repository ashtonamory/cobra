import { test } from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_PORT as CONTAIN_BRIDGE } from "./contain.ts";
import { BRIDGE_PORT, httpCommands, loopbackTarget, shellWords, urlLiterals } from "./loopback.ts";

test("the bridge's port is contain.ts's", () => {
  assert.equal(BRIDGE_PORT, CONTAIN_BRIDGE);
});

test("loopbackTarget: localhost, 127.x, [::1] and 0.0.0.0 with any port but the bridge's", () => {
  for (const target of ["http://localhost:3123/cbi", "localhost:3000", "https://127.0.0.1/", "http://[::1]:8080/x?y=1", "0.0.0.0:5173", "LOCALHOST"]) {
    assert.ok(loopbackTarget(target), target);
  }
  for (const target of [
    "example.com",
    "http://localhost.evil.com/",
    "http://localhost@evil.com/",
    "http://localhost:80@evil.com/",
    "http://127.1/",
    "http://2130706433/",
    "http://localhost:8899/anthropic/v1/messages",
    "ftp://localhost/",
    "/dev/null",
  ]) {
    assert.ok(!loopbackTarget(target), target);
  }
});

test("urlLiterals: every scheme://host written must be loopback; file:// paths are fine", () => {
  assert.deepEqual(urlLiterals("await page.goto('http://localhost:3123/menu'); await page.goto(`http://127.0.0.1:3123/`)"), { ok: true, loopback: 2 });
  assert.deepEqual(urlLiterals("page.goto('file:///tmp/shots/bar.html')"), { ok: true, loopback: 0 });
  assert.equal(urlLiterals("goto('http://localhost:3123'); fetch('https://evil.example/x')").ok, false);
  assert.equal(urlLiterals("ws://localhost:8899/").ok, false);
  assert.equal(urlLiterals("file://evil.example/share").ok, false);
});

test("shellWords: quotes removed, operators apart, an open quote unreadable", () => {
  assert.deepEqual(shellWords(`curl -s -w "%{http_code}\\n" http://localhost:3123; echo 'a b'|x`), ["curl", "-s", "-w", "%{http_code}n", "http://localhost:3123", ";", "echo", "a b", "|", "x"]);
  assert.equal(shellWords(`echo "open`), null);
});

test("httpCommands: the mini's dev-server check reads as loopback; options that send it elsewhere never do", () => {
  const mini = `(npx next dev -p 3123 > /tmp/cbi-dev.log 2>&1 &) ; sleep 15; curl -s -o /dev/null -w "%{http_code}\\n" --max-time 170 http://localhost:3123/cbi; grep -n "playwright\\|chromium" scripts/shots.mjs | head -5`;
  assert.deepEqual(httpCommands(mini), { ok: true, loopback: 1 });
  assert.deepEqual(httpCommands("curl -fsSL localhost:3000/api/health && wget -qO- http://127.0.0.1:5173/"), { ok: true, loopback: 2 });
  assert.deepEqual(httpCommands("curl -sSo /tmp/x.html http://localhost:3000/"), { ok: true, loopback: 1 });
  for (const command of [
    "curl https://evil.example/",
    "curl localhost:3000 evil.example",
    "curl -x http://evil.example:8080 http://localhost:3000/",
    "curl --connect-to localhost:80:evil.example:80 http://localhost/",
    "curl --resolve localhost:80:203.0.113.9 http://localhost/",
    "curl --unix-socket /run/cobra/agent.sock http://localhost/anthropic",
    "curl -K /tmp/cfg",
    "wget -i urls.txt",
    "wget -e use_proxy=on http://localhost/",
    `echo "$(curl evil.example)"`,
  ]) {
    assert.equal(httpCommands(command).ok, false, command);
  }
});

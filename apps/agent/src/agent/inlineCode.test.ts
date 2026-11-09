import assert from "node:assert/strict";
import { test } from "node:test";

import { INLINE_FLAG, inlineCode } from "./inlineCode.ts";

const codes = (shell: string) => inlineCode(shell)?.map((piece) => `${piece.kind}${piece.hidden ? "?" : ""}:${piece.code}`) ?? null;

test("the program each interpreter is given on the command line, quotes removed", () => {
  assert.deepEqual(codes(`python3 -c "import os; print('a')"`), ["python:import os; print('a')"]);
  assert.deepEqual(codes("python3 -Ic 'x = 1'"), ["python:x = 1"]);
  assert.deepEqual(codes("python3 -c'x = 1'"), ["python:x = 1"]);
  assert.deepEqual(codes("python3 -W ignore -c 'x'"), ["python:x"]);
  assert.deepEqual(codes("node -e 'a()'"), ["node:a()"]);
  assert.deepEqual(codes("node --eval='a()'"), ["node:a()"]);
  assert.deepEqual(codes("node -r dotenv/config -p 'a'"), ["node:a"]);
  assert.deepEqual(codes("deno eval 'a()'"), ["node:a()"]);
  assert.deepEqual(codes("bash -lc 'ls -la'"), ["shell:ls -la"]);
  assert.deepEqual(codes("sh -c -- 'ls'"), ["shell:ls"]);
  assert.deepEqual(codes("ruby -e 'a' -e 'b'"), ["other:a", "other:b"]);
  assert.deepEqual(codes("perl -lne 'print'"), ["other:print"]);
  // -M takes its module attached: `-Mfeature=say` is not `-e`.
  assert.deepEqual(codes("perl -Mfeature=say -E 'say 1'"), ["other:say 1"]);
  assert.deepEqual(codes("ruby -r json -e 'p 1'"), ["other:p 1"]);
  // Double quotes keep a backslash before anything but $ ` " \.
  assert.deepEqual(codes(String.raw`python3 -c "print(\"a\nb\")"`), [String.raw`python:print("a\nb")`]);
});

test("wrappers, runners, operators and substitutions are read through", () => {
  assert.deepEqual(codes("cd x && FOO=1 timeout 5 python3 -c 'a'; node -e 'b' | cat"), ["python:a", "node:b"]);
  assert.deepEqual(codes("uv run python -c 'a'"), ["python:a"]);
  assert.deepEqual(codes("pnpm exec tsx -e 'a'"), ["node:a"]);
  assert.deepEqual(codes("echo $(python3 -c 'a') `node -e 'b'`"), ["python:a", "node:b"]);
  assert.deepEqual(codes(`x="$(perl -e 'c')"`), ["other:c"]);
});

test("a program that is only an expansion is hidden; one with text around a variable is not", () => {
  assert.deepEqual(codes('python3 -c "$CODE"'), ["python?:$CODE"]);
  assert.deepEqual(codes("python3 -c ${CODE}"), ["python?:${CODE}"]);
  assert.deepEqual(codes('node -e "$(cat x.js)"'), ["node?:$(cat x.js)"]);
  assert.deepEqual(codes(`python3 -c "print('$HOME')"`), ["python:print('$HOME')"]);
  // In single quotes a $ is text, as Perl writes its variables.
  assert.deepEqual(codes("perl -e '$x = 1'"), ["other:$x = 1"]);
});

test("a script, a module or an argument is not code on the command line", () => {
  for (const shell of [
    "python3 script.py -c 'x'",
    "python3 -m http.server",
    "python3 - <<'EOF'",
    "node app.js -e 'x'",
    "bash run.sh -c 'x'",
    "deno run x.ts",
    "echo python3 -c",
    "grep -e 'python3 -c x' notes.md",
  ]) {
    assert.deepEqual(codes(shell), [], shell);
  }
});

test("text it cannot read whole is null, and the rough reading still sees an interpreter's code flag", () => {
  assert.equal(inlineCode(`python3 -c "import socket`), null);
  assert.equal(inlineCode("echo 'open"), null);
  assert.ok(INLINE_FLAG.test(`python3 -c "import socket`));
  assert.ok(INLINE_FLAG.test("node --eval 'x"));
  assert.ok(!INLINE_FLAG.test("echo 'don't"));
});

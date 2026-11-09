import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@cobra/contracts";

import { type CreateDeps, type CreateRequest, createProject, withinRoots } from "./create.ts";
import { pushRefusal } from "./github.ts";
import { SessionError } from "./sessions.ts";

const ROOTS = ["/home/me", "/home/me/Projects"];

function registered(patch: Partial<Project> = {}): Project {
  return {
    id: "plant-shop",
    name: "Plant Shop",
    machine: "omarchy",
    path: "/home/me/Projects/plant-shop",
    session: "plant-shop",
    ...patch,
  };
}

type Log = string[];

function deps(patch: Partial<CreateDeps> = {}, log: Log = []): CreateDeps {
  return {
    machine: "omarchy",
    roots: ROOTS,
    registered: [registered()],
    gh: "/usr/bin/gh",
    githubAuth: true,
    exists: async () => false,
    isDirectory: async () => true,
    isEmpty: async () => true,
    initRepo: async (path) => void log.push(`init ${path}`),
    clone: async (repo, destination) => void log.push(`clone ${repo} ${destination}`),
    createRemote: async (name) => {
      log.push(`remote ${name}`);
      return `https://github.com/octocat/${name}`;
    },
    trust: async (path) => {
      log.push(`trust ${path}`);
      return { trusted: true };
    },
    sessionExists: async () => false,
    startSession: async (session, cwd) => void log.push(`start ${session} ${cwd}`),
    save: async (project) => void log.push(`save ${project.id}`),
    ...patch,
  };
}

async function failure(
  request: CreateRequest,
  patch: Partial<CreateDeps> = {},
): Promise<SessionError> {
  try {
    await createProject(deps(patch), request);
  } catch (caught) {
    assert.ok(caught instanceof SessionError, `expected a SessionError, got ${String(caught)}`);
    return caught;
  }
  throw new Error("expected a failure");
}

test("init does the work in order: directory, register, trust, start", async () => {
  // The order is the design. Registering before the directory exists would
  // leave a card pointing at nothing; trusting after the session starts would
  // be too late, because Claude has already decided to ask.
  const log: Log = [];
  const result = await createProject(
    deps({}, log),
    { mode: "init", root: "/home/me/Projects", directory: "the-ledger" },
  );
  assert.deepEqual(log, [
    "init /home/me/Projects/the-ledger",
    "save the-ledger",
    "trust /home/me/Projects/the-ledger",
    "start the-ledger /home/me/Projects/the-ledger",
  ]);
  assert.equal(result.started, true);
  assert.equal(result.trusted, true);
  assert.equal(result.project.source, "local");
  assert.equal(result.project.machine, "omarchy");
});

test("a clone lands under the chosen root and takes the repo's name", async () => {
  const log: Log = [];
  const result = await createProject(
    deps({}, log),
    { mode: "clone", repo: "octocat/the-ledger", root: "/home/me" },
  );
  assert.equal(result.project.path, "/home/me/the-ledger");
  assert.equal(log[0], "clone octocat/the-ledger /home/me/the-ledger");
});

test("a saved Foreman trade is kept on the new project", async () => {
  let saved: Project | undefined;
  await createProject(deps({ save: async (project) => void (saved = project) }), {
    mode: "init", directory: "northstar-site", foremanTemplate: "website-builder",
  });
  assert.equal(saved?.foremanTemplate, "website-builder");
});

test("the remote is only created when asked, and its URL comes back", async () => {
  const log: Log = [];
  const plain = await createProject(deps({}, log), { mode: "init", directory: "quiet" });
  assert.equal(plain.remoteUrl, null);
  assert.equal(log.some((line) => line.startsWith("remote ")), false);

  const published = await createProject(deps(), {
    mode: "init",
    directory: "loud",
    remote: true,
  });
  assert.equal(published.remoteUrl, "https://github.com/octocat/loud");
});

test("a refused first push still registers the project, and says why there is no remote", async () => {
  // GitHub's email privacy refusal (GH007) arrives after the directory and its
  // first commit exist; failing the call stranded them unregistered.
  const log: Log = [];
  const result = await createProject(
    deps(
      {
        createRemote: async () => {
          throw new SessionError(pushRefusal("remote: error: GH007: Your push would publish a private email address.") ?? "", 502);
        },
      },
      log,
    ),
    { mode: "init", directory: "website-manager", remote: true },
  );
  assert.equal(result.remoteUrl, null);
  assert.equal(result.started, true);
  assert.ok(log.includes("save website-manager"));
  assert.match(result.warnings.join("\n"), /no GitHub remote yet \(GitHub refused the push: the commit's email is private/);
});

test("only GitHub's email refusal gets the noreply advice", () => {
  assert.match(pushRefusal("remote: error: GH007: Your push would publish a private email address.") ?? "", /noreply/);
  assert.equal(pushRefusal("fatal: could not read Username"), null);
});

test("nothing is written outside the configured roots", async () => {
  // The boundary that stops the phone creating a directory anywhere on the
  // machine. Widening it is a reviewed commit, not a request parameter.
  const escaped = await failure({ mode: "adopt", path: "/etc/cron.d" });
  assert.equal(escaped.status, 400);
  assert.match(escaped.message, /must be under/);

  const climbed = await failure({ mode: "adopt", path: "/home/me/../../etc" });
  assert.equal(climbed.status, 400);
  assert.match(climbed.message, /\.\./);

  const unknownRoot = await failure({ mode: "init", root: "/srv", directory: "x" });
  assert.equal(unknownRoot.status, 400);
  assert.match(unknownRoot.message, /root must be one of/);

  // "." and ".." are made only of characters a directory name may contain, and
  // "<root>/.." is outside the root while still having it as a string prefix —
  // so withinRoots cannot catch it and the name has to be refused instead.
  for (const mode of ["init", "clone"] as const) {
    for (const directory of [".", ".."]) {
      const relative = await failure({ mode, directory, repo: "octocat/x" });
      assert.equal(relative.status, 400, `${mode} ${directory}`);
    }
  }
  const dot = await failure({ mode: "adopt", path: "/home/me/Projects/." });
  assert.equal(dot.status, 400);
});

test("an id or path already registered is refused, naming the conflict", async () => {
  // Silently making "plant-shop-2" would give a card whose session is not the
  // one on screen, which is worse than a refusal.
  const byId = await failure({ mode: "init", root: "/home/me", directory: "plant-shop" });
  assert.equal(byId.status, 409);
  assert.match(byId.message, /already exists/);

  // An id derived from the directory name need not match the entry's own id —
  // the real config has "control-plane-macbook" at ~/dev-control-plane — so the
  // path check is a separate guard, not a restatement of the id one.
  const byPath = await failure(
    { mode: "adopt", path: "/home/me/dev-control-plane" },
    {
      registered: [
        registered({ id: "control-plane-macbook", path: "/home/me/dev-control-plane" }),
      ],
    },
  );
  assert.equal(byPath.status, 409);
  assert.match(byPath.message, /already the project/);
});

test("a live tmux session of that name is refused", async () => {
  const clash = await failure({ mode: "init", directory: "busy" }, { sessionExists: async () => true });
  assert.equal(clash.status, 409);
  assert.match(clash.message, /already running/);
});

test("a directory name that would reach a command line is refused", async () => {
  for (const directory of ["semi;colon", "sp ace", "../escape", "", "a/b"]) {
    const rejected = await failure({ mode: "init", directory });
    assert.equal(rejected.status, 400, `expected 400 for ${JSON.stringify(directory)}`);
  }
});

test("nothing touches the disk before validation has passed", async () => {
  // The cheapest failure is the one that touched nothing.
  const log: Log = [];
  const touching = deps({ sessionExists: async () => true }, log);
  await assert.rejects(() => createProject(touching, { mode: "init", directory: "nope" }));
  assert.deepEqual(log, []);
});

test("clone and remote need gh, and say which half is missing", async () => {
  const missing = await failure({ mode: "clone", repo: "a/b" }, { gh: null });
  assert.equal(missing.status, 409);
  assert.match(missing.message, /not installed/);

  const loggedOut = await failure({ mode: "clone", repo: "a/b" }, { githubAuth: false });
  assert.equal(loggedOut.status, 409);
  assert.match(loggedOut.message, /gh auth login/);

  // init without a remote needs neither.
  const fine = await createProject(deps({ gh: null, githubAuth: false }), {
    mode: "init",
    directory: "offline",
  });
  assert.equal(fine.started, true);
});

test("a clone with no repo says so, rather than blaming the directory name", async () => {
  const missing = await failure({ mode: "clone" });
  assert.equal(missing.status, 400);
  assert.match(missing.message, /needs a repo/);
});

test("a clone refuses to land on something already there", async () => {
  const occupied = await failure(
    { mode: "clone", repo: "a/b" },
    { exists: async () => true },
  );
  assert.equal(occupied.status, 409);
  assert.match(occupied.message, /already exists/);
});

test("init tolerates an existing empty directory but not a full one", async () => {
  const empty = await createProject(
    deps({ exists: async () => true, isEmpty: async () => true }),
    { mode: "init", directory: "mine" },
  );
  assert.equal(empty.started, true);

  const full = await failure(
    { mode: "init", directory: "mine" },
    { exists: async () => true, isEmpty: async () => false },
  );
  assert.equal(full.status, 409);
  assert.match(full.message, /not empty/);
});

test("adopt requires the directory to be there", async () => {
  const gone = await failure({ mode: "adopt", path: "/home/me/ghost" });
  assert.equal(gone.status, 404);
});

test("a failed trust is a warning, not a failure — the dialog is answerable", async () => {
  const result = await createProject(
    deps({ trust: async () => ({ trusted: false, reason: "busy" }) }),
    { mode: "init", directory: "untrusted" },
  );
  assert.equal(result.trusted, false);
  assert.equal(result.started, true);
  assert.match(result.warnings.join(" "), /Cobra will ask once/);
});

test("a session that will not start still leaves a registered project", async () => {
  // Degraded success: the card appears under "not started" and a tap starts it.
  // Failing the whole call would leave the same state and say nothing was made.
  const log: Log = [];
  const result = await createProject(
    deps(
      {
        startSession: async () => {
          throw new SessionError("tmux is not running", 500);
        },
      },
      log,
    ),
    { mode: "init", directory: "stubborn" },
  );
  assert.equal(result.started, false);
  assert.ok(log.includes("save stubborn"));
  assert.match(result.warnings.join(" "), /could not start the session/);
});

test("start: false registers without touching tmux", async () => {
  const log: Log = [];
  const result = await createProject(deps({}, log), {
    mode: "init",
    directory: "later",
    start: false,
  });
  assert.equal(result.started, false);
  assert.equal(log.some((line) => line.startsWith("start ")), false);
  assert.ok(log.includes("save later"));
});

test("a given name is used for display but never for the id or the path", async () => {
  const result = await createProject(deps(), {
    mode: "init",
    directory: "the-ledger",
    name: "The Ledger",
  });
  assert.equal(result.project.name, "The Ledger");
  assert.equal(result.project.id, "the-ledger");
  assert.equal(result.project.path, "/home/me/the-ledger");
});

test("withinRoots does not match a sibling by prefix", () => {
  // "/home/me/Projects-old" starts with a root's characters but is not in it.
  assert.equal(withinRoots("/home/me/Projects/x", ROOTS), true);
  assert.equal(withinRoots("/home/me", ROOTS), true);
  assert.equal(withinRoots("/home/me-old/x", ROOTS), false);
  assert.equal(withinRoots("/home/mex", ROOTS), false);
});

test("the same repository on a second machine is suffixed, not refused", async () => {
  // The case this was written for: plant-shop is the Legion's, and the MacBook
  // wants its own checkout of it while travelling. The registry is deployed
  // whole, so before this the Legion's entry occupied the name here too and
  // the create 409'd against a card this machine does not even serve.
  const log: Log = [];
  const result = await createProject(
    deps({ machine: "macbook" }, log),
    { mode: "clone", repo: "octocat/plant-shop", root: "/home/me/Projects" },
  );

  assert.equal(result.project.id, "plant-shop-macbook");
  // The path is identical to the Legion's on purpose: a directory should never
  // have to be renamed to dodge a collision, the way ~/dev-control-plane was.
  assert.equal(result.project.path, "/home/me/Projects/plant-shop");
  // And the session keeps the bare name, because tmux is per machine — so the
  // same `tmux a -t plant-shop` works wherever you are sitting.
  assert.equal(result.project.session, "plant-shop");
});

test("a second checkout at the same path as another machine's is allowed", async () => {
  const result = await createProject(
    deps({ machine: "macbook", exists: async () => true }),
    { mode: "adopt", path: "/home/me/Projects/plant-shop" },
  );
  assert.equal(result.project.id, "plant-shop-macbook");
});

test("the clash that still matters is one on this machine", async () => {
  // Same id and same path, this time genuinely already on this machine's list.
  const byId = await failure(
    { mode: "init", root: "/home/me/Projects", directory: "plant-shop" },
    { machine: "omarchy" },
  );
  assert.equal(byId.status, 409);
  assert.match(byId.message, /already exists/);

  // Suffixed once and no further: a machine that already has plant-shop-macbook
  // is told so by name rather than handed plant-shop-macbook-macbook.
  const twice = await failure(
    { mode: "adopt", path: "/home/me/Projects/plant-shop" },
    {
      machine: "macbook",
      registered: [
        registered(),
        registered({
          id: "plant-shop-macbook",
          machine: "macbook",
          path: "/home/me/other-stable",
        }),
      ],
    },
  );
  assert.equal(twice.status, 409);
  assert.match(twice.message, /plant-shop-macbook/);
});

test("a project made inside a Space's folder lands there, and its id comes from the hint so two Spaces' CRMs never clash", async () => {
  const log: Log = [];
  const first = await createProject(deps({}, log), { mode: "init", root: "/home/me/Projects", under: "happy-tails", directory: "crm", idHint: "happy-tails-crm", start: false });
  assert.equal(first.project.path, "/home/me/Projects/happy-tails/crm");
  assert.equal(first.project.id, "happy-tails-crm");
  assert.equal(first.project.session, "happy-tails-crm");
  assert.ok(log.includes("init /home/me/Projects/happy-tails/crm"));
  // The second Space's CRM has the same folder name and a different id.
  const second = await createProject(deps({ registered: [registered(), first.project] }), { mode: "init", root: "/home/me/Projects", under: "maya-s-soccer", directory: "crm", idHint: "maya-s-soccer-crm", start: false });
  assert.equal(second.project.path, "/home/me/Projects/maya-s-soccer/crm");
  assert.equal(second.project.id, "maya-s-soccer-crm");
  // Without the hint the folder name is the id, as before, and the clash is refused.
  assert.equal((await failure({ mode: "init", root: "/home/me/Projects", under: "other", directory: "crm", start: false }, { registered: [registered({ id: "crm", path: "/x/crm" })] })).status, 409);
});

test("under is one folder name, never a path", async () => {
  for (const under of ["..", ".", "a/b", "", "x".repeat(65)]) {
    assert.equal((await failure({ mode: "init", root: "/home/me/Projects", under, directory: "crm" })).status, 400, JSON.stringify(under));
  }
});

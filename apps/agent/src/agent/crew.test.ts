import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

import { changeCrew, CrewError, crewFor, projectNamed, resetCrewCache, withCrew } from "./crew.ts";

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, machine: "omarchy", path: `/home/me/${id}`, session: id, ...extra };
}

function fresh(): string {
  resetCrewCache();
  return join(mkdtempSync(join(tmpdir(), "crew-")), "crew.json");
}

test("each repository's Foreman is named once and kept, private", () => {
  const path = fresh();
  const crews = crewFor([project("plant-shop"), project("sportsbook"), project("cobra")], path);
  assert.equal(crews["plant-shop"]?.name.charAt(0), "P");
  assert.equal(crews.sportsbook?.name.charAt(0), "S");
  assert.notEqual(crews["plant-shop"]?.name, crews.sportsbook?.name);
  assert.notEqual(crews["plant-shop"]?.hat, crews.sportsbook?.hat);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const kept = JSON.parse(readFileSync(path, "utf8")) as { foremen: Record<string, unknown> };
  assert.deepEqual(Object.keys(kept.foremen).sort(), ["cobra", "plant-shop", "sportsbook"]);
  // Read again from the file: the same people.
  resetCrewCache();
  assert.deepEqual(crewFor([project("plant-shop")], path)["plant-shop"], crews["plant-shop"]);
});

test("a session, a Worker and the Foreman wear their repository's crew; the Lead wears none", () => {
  const path = fresh();
  const listed = withCrew(
    [
      project("cobra"),
      project("cobra_7", { parent: "cobra", worker: { owner: "cobra", task: "t", model: "sonnet" } }),
      project("cobra_fm", { parent: "cobra", foreman: true }),
      project("lead", { lead: true }),
    ],
    path,
  );
  const crew = listed[0]?.crew;
  assert.ok(crew);
  assert.deepEqual(listed[1]?.crew, crew);
  assert.deepEqual(listed[2]?.crew, crew);
  assert.equal(listed[3]?.crew, undefined);
  assert.equal(crewFor([], path).lead, undefined);
});

test("a rename is kept, a clash or a bad name refused, and null gives the name back", () => {
  const path = fresh();
  const stable = project("plant-shop");
  const book = project("sportsbook");
  const given = crewFor([stable, book], path);
  assert.equal(changeCrew(stable, { name: "  Big Al " }, path).name, "Big Al");
  resetCrewCache();
  assert.equal(crewFor([stable], path)["plant-shop"]?.name, "Big Al");
  assert.throws(() => changeCrew(book, { name: "big al" }, path), (caught: unknown) => caught instanceof CrewError && caught.status === 409);
  assert.throws(() => changeCrew(book, { name: "Cobra" }, path), (caught: unknown) => caught instanceof CrewError && caught.status === 400);
  assert.equal(changeCrew(stable, { name: null }, path).name, given["plant-shop"]?.name);
});

test("a new look counts up and resets, and the name stays", () => {
  const path = fresh();
  const cobra = project("cobra");
  const name = crewFor([cobra], path).cobra?.name;
  assert.equal(changeCrew(cobra, { look: "next" }, path).look, 1);
  assert.equal(changeCrew(cobra, { look: "next" }, path).look, 2);
  const reset = changeCrew(cobra, { look: "reset" }, path);
  assert.equal(reset.look, 0);
  assert.equal(reset.name, name);
});

test("a session is not a repository and has no crew to change", () => {
  const path = fresh();
  assert.throws(() => changeCrew(project("cobra_7", { parent: "cobra" }), { look: "next" }, path), CrewError);
});

test("the Lead finds a project by its id, its Foreman's name after @, or its own name", () => {
  const path = fresh();
  const stable = project("plant-shop", { name: "Plant Shop" });
  const book = project("sportsbook", { name: "The Book" });
  changeCrew(stable, { name: "Rusty" }, path);
  const projects = [stable, book];
  assert.equal(projectNamed(projects, "plant-shop", path), stable);
  assert.equal(projectNamed(projects, "Rusty", path), stable);
  assert.equal(projectNamed(projects, " @rusty ", path), stable, "as the person writes it, any case");
  assert.equal(projectNamed(projects, "@the book", path), book, "a project by its own name");
  assert.equal(projectNamed(projects, crewFor(projects, path).sportsbook!.name, path), book);
  assert.equal(projectNamed(projects, "Nobody", path), undefined);
  assert.equal(projectNamed(projects, "", path), undefined);
});

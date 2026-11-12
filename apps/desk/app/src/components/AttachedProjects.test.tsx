import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachedList } from "./AttachedProjects.tsx";
import { ATTACH_MAX, attachChoices, attachedTo, rosterOf } from "../lib/specialistProjects.ts";

const answer = {
  specialists: [
    { id: "invoicing", project: "Invoicing", name: "Rosa", repos: [{ id: "shop", name: "Shop", path: "/home/u/Projects/shop" }] },
    { id: "shop", project: "Shop", name: "Stan", repos: [] },
    { id: "website", project: "Website", name: "Ana", repos: [] },
    // An older agent's row has no list: it reads as none.
    { id: "notes", project: "Notes", name: "Kim" },
    { project: "no id" },
  ],
  models: ["opus"],
};
const none = { onPick: () => {}, onAttach: () => {}, onDetach: () => {} };

describe("the projects a specialist is attached to", () => {
  it("reads the roster with care, and offers only the projects it is not attached to yet", () => {
    const roster = rosterOf(answer);
    expect(roster.map((entry) => entry.id)).toEqual(["invoicing", "shop", "website", "notes"]);
    expect(attachedTo(roster, "invoicing")).toEqual([{ id: "shop", name: "Shop", path: "/home/u/Projects/shop" }]);
    expect(attachedTo(roster, "notes")).toEqual([]);
    // Never its own project, never one it already has; by name.
    expect(attachChoices(roster, "invoicing")).toEqual([{ id: "notes", name: "Notes" }, { id: "website", name: "Website" }]);
    expect(rosterOf(null)).toEqual([]);
    expect(rosterOf({ specialists: "x" })).toEqual([]);
  });

  it("lists each attached project with Detach, and offers to attach another", () => {
    const html = renderToStaticMarkup(<AttachedList roster={rosterOf(answer)} id="invoicing" name="Rosa" picking={false} busy={false} {...none} />);
    expect(html).toContain("Also works on");
    expect(html).toContain("Shop");
    expect(html).toContain("Detach");
    expect(html).toContain("Attach a project…");
    // The person's words: never the crew's.
    for (const word of ["Foreman", "Worker", "repo", "repository"]) expect(html).not.toContain(word);
  });

  it("says what attaching gives before the person picks", () => {
    const html = renderToStaticMarkup(<AttachedList roster={rosterOf(answer)} id="shop" name="Stan" picking busy={false} {...none} />);
    expect(html).toContain("Stan will read that project&#x27;s files and can start work that changes them. Every change still comes to you before it is published.");
    for (const name of ["Invoicing", "Notes", "Website"]) expect(html).toContain(name);
    expect(html).toContain("Cancel");
  });

  it("says so when it has only its own project, and when it has as many as one may", () => {
    const alone = renderToStaticMarkup(<AttachedList roster={rosterOf(answer)} id="website" name="Ana" picking={false} busy={false} {...none} />);
    expect(alone).toContain("Only its own project.");
    const many = { specialists: [{ id: "a", project: "A", name: "Rosa", repos: Array.from({ length: ATTACH_MAX }, (_, n) => ({ id: `r${n}`, name: `R${n}`, path: "" })) }, { id: "b", project: "B", name: "Stan", repos: [] }] };
    const full = renderToStaticMarkup(<AttachedList roster={rosterOf(many)} id="a" name="Rosa" picking={false} busy={false} {...none} />);
    expect(full).toContain("Detach one to attach another.");
    expect(full).not.toContain("Attach a project…");
  });
});

describe("a specialist hired on its own", () => {
  const roster = rosterOf({
    specialists: [
      { id: "billing", project: "Billing", name: "Rosa", standalone: true, repos: [] },
      { id: "shop", project: "Shop", name: "Stan", repos: [] },
    ],
  });

  it("is never a project to attach another specialist to", () => {
    expect(attachChoices(roster, "shop")).toEqual([]);
    expect(attachChoices(roster, "billing")).toEqual([{ id: "shop", name: "Shop" }]);
  });

  it("says it has no project yet, not that it has one of its own", () => {
    const html = renderToStaticMarkup(<AttachedList roster={roster} id="billing" name="Rosa" picking={false} busy={false} {...none} />);
    expect(html).toContain("No project yet. Attach Rosa to a project you already have");
    expect(html).not.toContain("Only its own project.");
    expect(html).not.toContain("Also works on");
  });
});

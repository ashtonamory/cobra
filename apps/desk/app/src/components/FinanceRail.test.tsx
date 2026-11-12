// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicView, ViewList, ViewResult } from "../../../../../packages/contracts/src/views.ts";

const calls = vi.hoisted(() => ({ view: [] as Array<{ id: string; input: Record<string, string> }>, toasts: [] as string[], picked: null as string[] | null, added: [] as string[], read: [] as string[][], refuse: null as { status: number; message: string } | null }));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => calls.picked }));
vi.mock("../app/context.ts", () => ({ useApp: () => ({ toast: (t: string) => void calls.toasts.push(t) }) }));
vi.mock("../lib/api.ts", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
  ApiError,
  addReceipt: async (_m: string, _p: string, path: string) => {
    if (calls.refuse) throw new ApiError(calls.refuse.status, calls.refuse.message);
    calls.added.push(path);
    return { file: `${path.split("/").pop()!.replace(/\W/g, "")}.kept` };
  },
  readReceipts: async (_m: string, _p: string, files: string[]) => {
    calls.read.push(files);
    return { reading: files.length };
  },
  view: async (_m: string, _p: string, id: string, input: Record<string, string> = {}) => {
    calls.view.push({ id, input });
    return RESULTS[id] ?? { view: id, kind: "list", title: id, rows: [], masked: [], more: false };
  },
  addStatement: async () => ({}),
  readStatement: async () => ({}),
  };
});

const { FinanceRail } = await import("./FinanceRail.tsx");
const { plainCtx } = await import("./Dashboard.tsx");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWS: PublicView[] = [
  { id: "fin-tiles", title: "This month", kind: "tiles", monthly: true, page: "Overview" },
  { id: "money-out", title: "Money out to allow", kind: "list", page: "Overview", peek: 1, hideEmpty: true,
    row: { id: "id", title: "title", trailing: "amount_cents" }, formats: { amount_cents: "money" }, batch: { mutation: "expenses_allow", label: "Allow all", amount: "home_cents" } },
  { id: "empty", title: "Nothing here", kind: "list", page: "Overview", hideEmpty: true, row: { id: "id", title: "title" } },
  { id: "fin-trust", title: "Trusted senders", kind: "list", page: "Transactions", row: { id: "id", title: "sender" },
    actions: [{ mutation: "trust_answer", label: "Trust", on: "row", fixed: { id: "id" }, values: { answer: "yes" }, showWhen: { column: "status", equals: "offered" } }] },
  { id: "expense", title: "Expense", kind: "page" },
];
const RESULTS: Record<string, ViewResult> = {
  "fin-tiles": { view: "fin-tiles", kind: "tiles", title: "This month", tiles: [{ label: "Kept", value: 150000, format: "money" }], masked: [], more: false },
  "money-out": { view: "money-out", kind: "list", title: "Money out", rows: [{ id: 1, title: "Treats", amount_cents: 8640, home_cents: 8640 }, { id: 2, title: "Leashes", amount_cents: 1200, home_cents: 1200 }], row: VIEWS[1]!.row, formats: { amount_cents: "money" }, masked: [], more: false },
  "fin-trust": { view: "fin-trust", kind: "list", title: "Trusted", rows: [{ id: 4, sender: "Petro-Canada", status: "offered" }], row: VIEWS[3]!.row, masked: [], more: false },
};
const LIST: ViewList = { project: "paws-money", trade: "money", currency: "USD", mutations: {}, views: VIEWS };

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  calls.view.length = 0;
});

async function draw(page: string, extra: Partial<Parameters<typeof FinanceRail>[0]> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const acted: string[] = [];
  const allowed: string[] = [];
  const seeAll: string[] = [];
  const ctx = { ...plainCtx("USD"), act: (a: { label: string }, id: string | null) => void acted.push(`${a.label}:${id}`) };
  await act(async () => {
    root.render(<FinanceRail machine="office" project="paws-money" list={LIST} pages={["Overview", "Transactions"]} ctx={ctx} round={0}
      page={page} onPage={() => {}} month="2026-10" onMonth={() => {}} onDrill={() => {}}
      onSeeAll={(v, month) => void seeAll.push(`${v.id}:${month}`)} allowAll={(_b, ids, label) => void allowed.push(`${label}:${ids}`)} onChanged={() => {}} {...extra} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { host: host!, acted, allowed, seeAll, root };
}

describe("the Finance rail", () => {
  it("lists the pages, reads the page's views for its month, and leaves an empty hideEmpty view off", async () => {
    const { host } = await draw("Overview");
    expect([...host.querySelectorAll(".fin-rail-item")].map((b) => b.textContent)).toEqual(["Overview", "Transactions"]);
    expect(host.querySelector(".fin-rail-item.on")?.textContent).toBe("Overview");
    expect(host.textContent).toContain("October 2026");
    expect(host.textContent).toContain("$1,500.00");
    expect(calls.view.find((c) => c.id === "fin-tiles")?.input).toEqual({ month: "2026-10" });
    expect(calls.view.find((c) => c.id === "money-out")?.input).toEqual({});
    expect(host.textContent).not.toContain("Nothing here");
    expect(calls.view.some((c) => c.id === "expense")).toBe(false);
  });

  it("cuts a list to its peek with See all, and Allow all sends the ids shown with the total", async () => {
    const { host, allowed, seeAll } = await draw("Overview");
    const card = host.querySelector('[aria-label="Money out to allow"]')!;
    expect(card.textContent).toContain("Treats");
    expect(card.textContent).not.toContain("Leashes");
    expect(card.textContent).toContain("2 · $98.40");
    await act(async () => { [...card.querySelectorAll("button")].find((b) => b.textContent === "Allow all")!.click(); });
    expect(allowed).toEqual(["Allow all 2:1,2"]);
    await act(async () => { [...card.querySelectorAll("button")].find((b) => b.textContent?.startsWith("See all"))!.click(); });
    expect(seeAll).toEqual(["money-out:null"]);
  });

  it("puts the statement drop and a trust offer's one-press answer on Transactions", async () => {
    const { host, acted } = await draw("Transactions");
    expect(host.textContent).toContain("Drop a bank statement here");
    const trust = [...host.querySelectorAll("button")].find((b) => b.textContent === "Trust")!;
    await act(async () => { trust.click(); });
    expect(acted).toEqual(["Trust:4"]);
    // Transactions follows no month.
    expect(host.textContent).not.toContain("October 2026");
  });

  it("sends the receipts chosen, starts the reading and says a card will ask", async () => {
    calls.picked = ["/p/lunch.jpg", "/p/fuel.png", "/p/notes.txt"];
    calls.added.length = 0; calls.read.length = 0; calls.toasts.length = 0; calls.refuse = null;
    const { host } = await draw("Transactions");
    expect(host.textContent).toContain("Drop receipts here");
    const add = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add receipts")!;
    await act(async () => { add.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.added).toEqual(["/p/lunch.jpg", "/p/fuel.png"]);
    expect(calls.read).toEqual([["lunchjpg.kept", "fuelpng.kept"]]);
    expect(calls.toasts[0]).toContain("notes.txt");
    expect(calls.toasts.at(-1)).toBe("Cobra is reading 2 receipts. A card will ask you before anything is recorded.");
  });

  it("reads nothing when the Space keeps no Money, and says so once", async () => {
    calls.picked = ["/p/a.jpg", "/p/b.jpg"];
    calls.added.length = 0; calls.read.length = 0; calls.toasts.length = 0; calls.refuse = { status: 404, message: "not seated" };
    const { host } = await draw("Transactions");
    const add = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add receipts")!;
    await act(async () => { add.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.read).toEqual([]);
    expect(calls.toasts).toEqual(["a.jpg was not sent: This Space keeps no Money yet, so there is nowhere to put a receipt."]);
    calls.refuse = null; calls.picked = null;
  });
});

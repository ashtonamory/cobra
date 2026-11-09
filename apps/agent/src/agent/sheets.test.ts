import assert from "node:assert/strict";
import { test } from "node:test";

import { GoogleAuthError } from "./googleAuth.ts";
import { openSheets, safeCell, SHEETS_API, sheetUrl, type SheetsOptions } from "./sheets.ts";

type Recorded = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** A fetch that records every request and answers from `answer`, defaulting to an empty JSON object. */
function fakeFetch(answer: (request: Recorded) => Response | undefined): { fetcher: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers as Record<string, string> | undefined) ?? {})) headers[key.toLowerCase()] = value;
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = headers["content-type"]?.includes("json") ? JSON.parse(init.body) : init.body;
    }
    const request = { method: init?.method ?? "GET", url, body, headers };
    requests.push(request);
    return answer(request) ?? json({});
  }) as typeof fetch;
  return { fetcher, requests };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A client on a fixed token, never the live connection. */
const sheetsOn = (fetcher: typeof fetch, options: SheetsOptions = {}) => openSheets({ token: async () => "tok-1", dropToken: () => {}, fetcher, ...options });

test("the injected token goes in the Authorization header of every call", async () => {
  const { fetcher, requests } = fakeFetch(() => undefined);
  await sheetsOn(fetcher).listTabs("sheet-id");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.authorization, "Bearer tok-1");
  assert.equal(requests[0]!.url, `${SHEETS_API}/sheet-id?fields=sheets.properties(sheetId,title)`);
});

test("a 401 drops the token and sends the call once more with a fresh one; a second 401 is passed on", async () => {
  let issued = 0;
  let dropped = 0;
  const token = async (): Promise<string> => `tok-${++issued}`;
  const dropToken = (): void => {
    dropped += 1;
  };
  const once = fakeFetch((request) => (request.headers.authorization === "Bearer tok-1" ? json({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401) : json({ sheets: [{ properties: { title: "employees" } }] })));
  assert.deepEqual(await openSheets({ token, dropToken, fetcher: once.fetcher }).listTabs("sheet-id"), ["employees"]);
  assert.deepEqual(once.requests.map((r) => r.headers.authorization), ["Bearer tok-1", "Bearer tok-2"]);
  assert.equal(dropped, 1, "dropped before the second token was asked for");

  const always = fakeFetch(() => json({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401));
  await assert.rejects(openSheets({ token, dropToken, fetcher: always.fetcher }).listTabs("sheet-id"), (error: Error & { status?: number }) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /even with a fresh token: Invalid Credentials \(UNAUTHENTICATED\)\. Connect Google again in the app/);
    return true;
  });
  assert.equal(always.requests.length, 2, "tried exactly twice");
  assert.equal(dropped, 2);
});

test("a GoogleAuthError from the token is passed on as it is, and nothing is sent", async () => {
  const { fetcher, requests } = fakeFetch(() => undefined);
  const refused = new GoogleAuthError("google_not_connected");
  await assert.rejects(openSheets({ token: async () => Promise.reject(refused), fetcher }).readTab("sheet-id", "Hours"), (error: unknown) => error === refused);
  assert.equal(requests.length, 0);
});

test("createSpreadsheet posts the title and answers the new id and its url", async () => {
  const { fetcher, requests } = fakeFetch((request) =>
    request.method === "POST" && request.url === SHEETS_API ? json({ spreadsheetId: "1NewSheet_abc", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/1NewSheet_abc/edit", properties: { title: "Payroll (Cobra)" } }) : undefined,
  );
  assert.deepEqual(await sheetsOn(fetcher).createSpreadsheet("Payroll (Cobra)"), { spreadsheetId: "1NewSheet_abc", url: "https://docs.google.com/spreadsheets/d/1NewSheet_abc/edit" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, SHEETS_API);
  assert.deepEqual(requests[0]!.body, { properties: { title: "Payroll (Cobra)" } });
  assert.equal(requests[0]!.headers.authorization, "Bearer tok-1");

  const noUrl = fakeFetch(() => json({ spreadsheetId: "1Other" }));
  assert.deepEqual(await sheetsOn(noUrl.fetcher).createSpreadsheet("x"), { spreadsheetId: "1Other", url: sheetUrl("1Other") });
  await assert.rejects(sheetsOn(fakeFetch(() => json({})).fetcher).createSpreadsheet("x"), /made no spreadsheet/);
});

test("safeCell: text that starts like a formula gets an apostrophe; numbers and booleans are left typed", () => {
  assert.equal(safeCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(safeCell("+1 555"), "'+1 555");
  assert.equal(safeCell("-dash"), "'-dash");
  assert.equal(safeCell("@mention"), "'@mention");
  assert.equal(safeCell("plain"), "plain");
  assert.equal(safeCell(-12.5), -12.5);
  assert.equal(safeCell(true), true);
  assert.equal(safeCell(null), null);
});

test("writeTab clears the tab, then updates it RAW with the header, quoted formula cells and empty cells for null", async () => {
  const { fetcher, requests } = fakeFetch(() => undefined);
  const client = sheetsOn(fetcher);
  await client.writeTab("sheet-id", "pay runs", ["id", "note", "net"], [[1, "=HYPERLINK(\"x\")", 1234.56], [2, null, -5]]);
  const calls = requests.filter((r) => r.url.startsWith(SHEETS_API));
  assert.equal(calls.length, 2);
  const [clear, update] = calls as [Recorded, Recorded];
  assert.equal(clear.method, "POST");
  assert.equal(clear.url, `${SHEETS_API}/sheet-id/values/${encodeURIComponent("'pay runs'")}:clear`);
  assert.equal(clear.headers.authorization, "Bearer tok-1");
  assert.equal(update.method, "PUT");
  assert.equal(update.url, `${SHEETS_API}/sheet-id/values/${encodeURIComponent("'pay runs'")}?valueInputOption=RAW`);
  assert.deepEqual(update.body, {
    majorDimension: "ROWS",
    values: [
      ["id", "note", "net"],
      [1, "'=HYPERLINK(\"x\")", 1234.56],
      [2, "", -5],
    ],
  });
});

test("readTab asks for unformatted values with dates as shown, and returns every cell as text", async () => {
  const { fetcher, requests } = fakeFetch((request) => {
    if (request.url.includes("/values/")) return json({ range: "'Hours'!A1:C3", values: [["name", "hours", "paid"], ["Ada", 7.5, true], ["Bob"]] });
    return undefined;
  });
  const client = sheetsOn(fetcher);
  const grid = await client.readTab("sheet-id", "Hours");
  assert.deepEqual(grid, [["name", "hours", "paid"], ["Ada", "7.5", "true"], ["Bob"]]);
  const read = requests.find((r) => r.url.includes("/values/"))!;
  assert.ok(read.url.includes("valueRenderOption=UNFORMATTED_VALUE"));
  assert.ok(read.url.includes("dateTimeRenderOption=FORMATTED_STRING"));
  assert.ok(read.url.includes(`/values/${encodeURIComponent("'Hours'")}?`));
});

test("listTabs reads the titles; ensureTab adds a missing tab through batchUpdate and leaves a present one alone", async () => {
  const tabs = ["Sheet1", "employees"];
  const { fetcher, requests } = fakeFetch((request) => {
    if (request.method === "GET" && request.url.includes("fields=sheets.properties")) {
      return json({ sheets: tabs.map((title, index) => ({ properties: { sheetId: index, title } })) });
    }
    if (request.url.endsWith(":batchUpdate")) {
      const title = (request.body as { requests: Array<{ addSheet: { properties: { title: string } } }> }).requests[0]!.addSheet.properties.title;
      tabs.push(title);
      return json({ replies: [{ addSheet: { properties: { title } } }] });
    }
    return undefined;
  });
  const client = sheetsOn(fetcher);
  assert.deepEqual(await client.listTabs("sheet-id"), ["Sheet1", "employees"]);
  assert.equal(await client.ensureTab("sheet-id", "employees"), false);
  assert.equal(await client.ensureTab("sheet-id", "pay_runs"), true);
  assert.deepEqual(tabs, ["Sheet1", "employees", "pay_runs"]);
  const added = requests.find((r) => r.url.endsWith(":batchUpdate"))!;
  assert.deepEqual(added.body, { requests: [{ addSheet: { properties: { title: "pay_runs" } } }] });
});

test("a 403 or 404 on a spreadsheet says the connection reaches only the sheets Cobra created or the person picked", async () => {
  const forbidden = fakeFetch(() => json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403));
  await assert.rejects(sheetsOn(forbidden.fetcher).listTabs("sheet-id"), (error: Error & { status?: number }) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /spreadsheet sheet-id \(403\): The caller does not have permission \(PERMISSION_DENIED\)/);
    assert.match(error.message, /reaches only the sheets Cobra created or the person picked, and this is not one of them/);
    return true;
  });
  const missing = fakeFetch(() => json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404));
  await assert.rejects(sheetsOn(missing.fetcher).readTab("sheet-id", "Hours"), (error: Error & { status?: number }) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /Check the id; Cobra's Google connection reaches only the sheets Cobra created or the person picked/);
    return true;
  });
});

test("other errors carry Google's message and status; a dead network is its own message", async () => {
  const { fetcher } = fakeFetch((request) => {
    if (request.url.startsWith(SHEETS_API)) return json({ error: { code: 400, message: "Unable to parse range: 'nope'", status: "INVALID_ARGUMENT" } }, 400);
    return undefined;
  });
  const client = sheetsOn(fetcher);
  await assert.rejects(client.readTab("sheet-id", "nope"), (error: Error & { status?: number }) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /answered 400: Unable to parse range: 'nope' \(INVALID_ARGUMENT\)/);
    return true;
  });
  const down = sheetsOn((async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  await assert.rejects(down.listTabs("sheet-id"), /could not be reached: fetch failed/);
});

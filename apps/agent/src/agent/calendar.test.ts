import { test } from "node:test";
import assert from "node:assert/strict";

// A zone with an offset, so a date alone is read as the person's local day and not UTC's.
process.env.TZ = "America/New_York";

const { CALENDAR_API, calendarEvents, calendarRequest, DESCRIPTION_MAX, GoogleReadOffError, MAX_ATTENDEES, parseWhen, ReadRequestError, trimEvent } = await import("./calendar.ts");
const { GoogleAuthError, SCOPE_CALENDAR_READONLY, SCOPE_DRIVE_FILE, SCOPE_GMAIL_READONLY } = await import("./googleAuth.ts");
type GoogleGrant = import("./googleAuth.ts").GoogleGrant;

const NOW = Date.UTC(2026, 9, 23, 13, 0, 0);
const GRANT: GoogleGrant = { accessToken: "ya29.first-token", expiresAt: NOW + 3_600_000, email: "penny@gmail.com", scopes: [SCOPE_DRIVE_FILE, SCOPE_CALENDAR_READONLY] };

type Answer = { status: number; body: unknown };
type Call = { url: URL; auth: string | null; method: string };

/**
 * Google as a router: each request's path picks a list of answers, one per
 * request, the last repeated; every request kept.
 */
function google(routes: Record<string, Answer[]>, grants: GoogleGrant[] = [GRANT]) {
  const calls: Call[] = [];
  let asked = 0;
  const fake = {
    calls,
    cleared: 0,
    get asked() {
      return asked;
    },
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
      const answers = routes[url.pathname];
      if (!answers || answers.length === 0) return new Response(JSON.stringify({ error: { code: 404, message: "not here" } }), { status: 404 });
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
    grant: async () => {
      asked += 1;
      return grants[Math.min(asked - 1, grants.length - 1)]!;
    },
    clearGrant: () => {
      fake.cleared += 1;
    },
  };
  return fake;
}

const LIST = "/calendar/v3/users/me/calendarList";
const events = (id: string) => `/calendar/v3/calendars/${encodeURIComponent(id)}/events`;

const CALENDARS = {
  items: [
    { id: "penny@gmail.com", summary: "penny@gmail.com", summaryOverride: "Penny", selected: true, primary: true },
    { id: "work-cal@group.calendar.google.com", summary: "Work", selected: true },
    // Subscribed but not shown in Google Calendar: never read.
    { id: "en.usa#holiday@group.v.calendar.google.com", summary: "Holidays in United States" },
    { id: "colleague@example.com", summary: "Colleague", selected: false },
  ],
};

test("only the calendars the person shows are read, each with singleEvents, startTime order, the span and the query; events merge in order of start", async () => {
  const fake = google({
    [LIST]: [{ status: 200, body: CALENDARS }],
    [events("penny@gmail.com")]: [
      {
        status: 200,
        body: {
          items: [
            { summary: "Dentist", start: { dateTime: "2026-10-24T15:00:00-04:00" }, end: { dateTime: "2026-10-24T16:00:00-04:00" }, status: "confirmed" },
            { summary: "Pay day", start: { date: "2026-10-24" }, end: { date: "2026-10-25" } },
          ],
        },
      },
    ],
    [events("work-cal@group.calendar.google.com")]: [
      { status: 200, body: { items: [{ summary: "Standup", start: { dateTime: "2026-10-24T13:30:00Z" }, end: { dateTime: "2026-10-24T13:45:00Z" }, status: "tentative" }] } },
    ],
  });
  const result = await calendarEvents(fake, { from: "2026-10-24", to: "2026-10-24", query: " dentist  " });
  // The list, then one events.list per shown calendar, nothing for the other two.
  assert.deepEqual(
    fake.calls.map((call) => call.url.pathname),
    [LIST, events("penny@gmail.com"), events("work-cal@group.calendar.google.com")],
  );
  assert.equal(fake.calls[0]!.url.searchParams.get("minAccessRole"), "reader");
  const list = fake.calls[1]!.url.searchParams;
  assert.equal(list.get("singleEvents"), "true");
  assert.equal(list.get("orderBy"), "startTime");
  // The 24th in New York, start to end: a date alone is the person's whole day.
  assert.equal(list.get("timeMin"), "2026-10-24T04:00:00.000Z");
  assert.equal(list.get("timeMax"), "2026-10-25T04:00:00.000Z");
  assert.equal(list.get("q"), "dentist");
  assert.equal(list.get("maxResults"), "100");
  for (const call of fake.calls) {
    assert.equal(call.auth, "Bearer ya29.first-token");
    assert.equal(call.method, "GET");
    assert.ok(!call.url.href.includes("ya29"), "the token is only in the header");
  }
  assert.deepEqual(result.calendars, ["Penny", "Work"]);
  assert.equal(result.from, "2026-10-24T04:00:00.000Z");
  assert.deepEqual(
    result.events.map((event) => [event.title, event.calendar, event.allDay, event.status]),
    [
      ["Pay day", "Penny", true, "confirmed"],
      ["Standup", "Work", false, "tentative"],
      ["Dentist", "Penny", false, "confirmed"],
    ],
  );
  assert.equal(result.more, false);
});

test("an event is trimmed to the spec's fields: attendees at most 20 with their answers, the meeting link, the description cut at 2,000, secrets scrubbed", () => {
  const attendees = Array.from({ length: 25 }, (_, n) => ({ email: `guest${n}@example.com`, responseStatus: n === 0 ? "accepted" : n === 1 ? "declined" : n === 2 ? "tentative" : "needsAction" }));
  const event = trimEvent(
    {
      summary: "Board call",
      start: { dateTime: "2026-10-26T09:00:00-04:00", timeZone: "America/New_York" } as never,
      end: { dateTime: "2026-10-26T10:00:00-04:00" },
      location: "Room 4",
      organizer: { email: "chair@example.com", displayName: "Chair" },
      attendees: [{ email: "room-4@resource.calendar.google.com", resource: true }, ...attendees],
      status: "confirmed",
      conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1555" }, { entryPointType: "video", uri: "https://zoom.us/j/123" }] },
      description: `Dial in.\napi_key = "sk-ant-api03-${"a1".repeat(30)}"\n${"x".repeat(3000)}`,
      // Everything else Google sends is left behind.
      htmlLink: "https://calendar.google.com/event?eid=abc",
      creator: { email: "someone@example.com" },
      extendedProperties: { private: { secret: "1" } },
    } as never,
    "Work",
  )!;
  assert.deepEqual(Object.keys(event).sort(), ["allDay", "attendees", "calendar", "description", "end", "location", "meetingLink", "moreAttendees", "organizer", "start", "status", "title"].sort());
  assert.equal(event.attendees.length, MAX_ATTENDEES);
  assert.equal(event.moreAttendees, 5);
  assert.deepEqual(event.attendees.slice(0, 4), [
    { email: "guest0@example.com", answer: "accepted" },
    { email: "guest1@example.com", answer: "declined" },
    { email: "guest2@example.com", answer: "maybe" },
    { email: "guest3@example.com", answer: "no answer" },
  ]);
  assert.equal(event.organizer, "chair@example.com");
  assert.equal(event.meetingLink, "https://zoom.us/j/123");
  assert.ok(event.description!.startsWith("Dial in.\n"));
  assert.ok(!event.description!.includes("sk-ant-api03"), "a key in a description never reaches the model");
  assert.match(event.description!, /\[redacted\]/);
  assert.ok(event.description!.length <= DESCRIPTION_MAX + 40);
  assert.match(event.description!, /… \[cut at 2000 characters\]$/);
  // hangoutLink wins; an event with no start is dropped; a missing title says so.
  assert.equal(trimEvent({ start: { date: "2026-10-26" }, end: { date: "2026-10-27" }, hangoutLink: "https://meet.google.com/abc-defg-hij" } as never, "Penny")?.meetingLink, "https://meet.google.com/abc-defg-hij");
  assert.equal(trimEvent({ start: { date: "2026-10-26" } } as never, "Penny")?.title, "(no title)");
  assert.equal(trimEvent({ summary: "no start" } as never, "Penny"), null);
});

test("at most 100 events across calendars, the earliest kept, with more said", async () => {
  const many = (hour: number) => Array.from({ length: 60 }, (_, n) => ({ summary: `e${hour}-${n}`, start: { dateTime: new Date(Date.UTC(2026, 9, 24 + Math.floor(n / 10), hour, n % 10)).toISOString() }, end: { dateTime: new Date(Date.UTC(2026, 9, 24 + Math.floor(n / 10), hour, 30)).toISOString() } }));
  const fake = google({
    [LIST]: [{ status: 200, body: { items: [CALENDARS.items[0], CALENDARS.items[1]] } }],
    [events("penny@gmail.com")]: [{ status: 200, body: { items: many(9) } }],
    [events("work-cal@group.calendar.google.com")]: [{ status: 200, body: { items: many(14) } }],
  });
  const result = await calendarEvents(fake, { from: "2026-10-24", to: "2026-11-02" });
  assert.equal(result.events.length, 100);
  assert.equal(result.more, true);
  const starts = result.events.map((event) => Date.parse(event.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "in order of start");
  // A smaller max is the cap instead, and is what each calendar is asked for.
  const few = google({ [LIST]: [{ status: 200, body: { items: [CALENDARS.items[0]] } }], [events("penny@gmail.com")]: [{ status: 200, body: { items: many(9).slice(0, 5), nextPageToken: "p2" } }] });
  const five = await calendarEvents(few, { from: "2026-10-24", to: "2026-11-02", max: 5 });
  assert.equal(few.calls[1]!.url.searchParams.get("maxResults"), "5");
  assert.equal(five.events.length, 5);
  assert.equal(five.more, true, "Google's next page means more");
});

test("a span over 31 days, to before from, and malformed times are refused before anything reaches Google", async () => {
  const refused = async (request: Record<string, unknown>, pattern: RegExp) => {
    const fake = google({ [LIST]: [{ status: 200, body: CALENDARS }] });
    await assert.rejects(calendarEvents(fake, request as never), (error: unknown) => {
      assert.ok(error instanceof ReadRequestError, String(error));
      assert.equal(error.status, 400);
      assert.match(error.message, pattern);
      return true;
    });
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.asked, 0, "no token asked for either");
  };
  await refused({ from: "2026-10-01", to: "2026-11-01" }, /at most 31 days/);
  await refused({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:01Z" }, /at most 31 days/);
  await refused({ from: "2026-10-24", to: "2026-10-23" }, /to is after from/);
  await refused({ from: "2026-10-24T10:00:00Z", to: "2026-10-24T10:00:00Z" }, /to is after from/);
  await refused({ from: "tomorrow", to: "2026-10-24" }, /from is an ISO date/);
  await refused({ from: "2026-02-30", to: "2026-03-02" }, /not a real date/);
  await refused({ from: "2026-10-24T25:00", to: "2026-10-25" }, /not a real time/);
  await refused({ to: "2026-10-24" }, /from is needed/);
  await refused({ from: "2026-10-24", to: "2026-10-25", query: "x".repeat(201) }, /at most 200/);
  await refused({ from: "2026-10-24", to: "2026-10-25", max: 101 }, /max is a whole number from 1 to 100/);
  // Exactly 31 days is allowed.
  assert.equal(calendarRequest({ from: "2026-10-01", to: "2026-10-31" }).to - calendarRequest({ from: "2026-10-01", to: "2026-10-31" }).from, 31 * 86_400_000);
  // A date-time with no offset is local; one with an offset is that instant.
  assert.equal(parseWhen("2026-10-24T09:00", "from"), Date.UTC(2026, 9, 24, 13, 0));
  assert.equal(parseWhen("2026-10-24T09:00:00+01:00", "from"), Date.UTC(2026, 9, 24, 8, 0));
});

test("a calendar the person has not turned on is the step to take, with no request to Google; Google's own scope refusal says the same", async () => {
  const noScope = google({ [LIST]: [{ status: 200, body: CALENDARS }] }, [{ ...GRANT, scopes: [SCOPE_DRIVE_FILE, SCOPE_GMAIL_READONLY] }]);
  await assert.rejects(calendarEvents(noScope, { from: "2026-10-24", to: "2026-10-25" }), (error: unknown) => {
    assert.ok(error instanceof GoogleReadOffError);
    assert.ok(error instanceof GoogleAuthError, "passed on like any connection problem");
    assert.equal(error.status, 409);
    assert.equal(error.read, "calendar");
    assert.match(error.message, /turns on Calendar in the app, Settings → Integrations → Google/);
    return true;
  });
  assert.equal(noScope.calls.length, 0);

  const googleSays = google({ [LIST]: [{ status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] } } }] });
  await assert.rejects(calendarEvents(googleSays, { from: "2026-10-24", to: "2026-10-25" }), (error: unknown) => error instanceof GoogleReadOffError && error.read === "calendar");
});

test("a 401 drops the grant and asks once more with a fresh one; a second 401 says connect again; other refusals are Google's words without the token", async () => {
  const fresh: GoogleGrant = { ...GRANT, accessToken: "ya29.second-token" };
  const fake = google(
    {
      [LIST]: [{ status: 401, body: { error: { code: 401 } } }, { status: 200, body: { items: [CALENDARS.items[0]] } }],
      [events("penny@gmail.com")]: [{ status: 200, body: { items: [] } }],
    },
    [GRANT, fresh],
  );
  const result = await calendarEvents(fake, { from: "2026-10-24", to: "2026-10-25" });
  assert.deepEqual(result.events, []);
  assert.equal(fake.cleared, 1);
  assert.deepEqual(fake.calls.map((call) => call.auth), ["Bearer ya29.first-token", "Bearer ya29.second-token", "Bearer ya29.second-token"]);

  const twice = google({ [LIST]: [{ status: 401, body: {} }] }, [GRANT, fresh]);
  await assert.rejects(calendarEvents(twice, { from: "2026-10-24", to: "2026-10-25" }), (error: unknown) => {
    assert.ok(error instanceof GoogleAuthError);
    assert.equal(error.problem, "google_reconnect");
    assert.match(error.message, /connect/);
    return true;
  });
  assert.equal(twice.calls.length, 2, "never a third try");

  const down = google({ [LIST]: [{ status: 503, body: { error: { code: 503, message: "Backend Error ya29.leaked-token", status: "UNAVAILABLE" } } }] });
  await assert.rejects(calendarEvents(down, { from: "2026-10-24", to: "2026-10-25" }), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof GoogleAuthError));
    assert.match(error.message, /^Google Calendar had a problem on Google's side/);
    assert.ok(!error.message.includes("ya29"));
    return true;
  });
  assert.ok(CALENDAR_API.startsWith("https://www.googleapis.com/"));
});

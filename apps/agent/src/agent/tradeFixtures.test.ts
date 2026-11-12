// A defined trade for the tests of tradeDefine.ts, definedTrades.ts and tradeRoutes.ts (a .test.ts, so the package leaves it out).
export const DOG_WALKING = {
  id: "dog-walking",
  name: "Dog walking",
  summary: "Keeps the dogs, their owners and the week's walks; proposes the confirmations, never takes a payment.",
  brief: "You run a dog-walking round: the dogs, their owners and the walks booked each week.",
  reads: ["mail"],
  tables: {
    owners: { describe: "The people whose dogs are walked", columns: { name: { kind: "text", required: true }, email: { kind: "text" }, address: { kind: "text", sensitive: true }, archived_at: { kind: "text" } } },
    dogs: { describe: "Each dog", columns: { name: { kind: "text", required: true }, owner_id: { kind: "integer", required: true, ref: "owners" }, size: { kind: "text", values: ["small", "medium", "large"] } } },
    walks: { describe: "One booked walk", columns: { dog_id: { kind: "integer", required: true, ref: "dogs" }, walk_date: { kind: "date", required: true }, fee: { kind: "money" }, status: { kind: "text", values: ["booked", "done", "missed"] } } },
  },
  mutations: {
    owner_add: { op: "insert", table: "owners", describe: "Add an owner", fields: ["name", "email", "address"], unique: ["email"] },
    owner_archive: { op: "archive", table: "owners", describe: "Archive an owner who left" },
    dog_add: { op: "insert", table: "dogs", describe: "Add a dog", fields: ["name", "owner_id", "size"] },
    walk_book: { op: "insert", table: "walks", describe: "Book a walk", fields: ["dog_id", "walk_date", "fee", "status"] },
    walk_update: { op: "update", table: "walks", describe: "Change a walk", fields: ["walk_date", "status"] },
    walk_remove: { op: "remove", table: "walks", describe: "Delete a walk booked by mistake" },
  },
  templates: { "week-sheet": { describe: "The week's walks", html: "<html><body>{{#each rows}}<p>{{name}}</p>{{/each}}</body></html>", sample: { rows: [{ name: "Rex" }] } } },
  needs: [{ service: "Stripe", purpose: "taking card payments", fallback: "a CSV of the week's fees the person enters in Stripe themselves" }],
};

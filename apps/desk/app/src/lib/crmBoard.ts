/**
 * The desk CRM's board rules: they live in contracts crmBoard.ts, shared with the phone's
 * board; this file is the desk's name for them. vitest in crmBoard.test.ts.
 */
export * from "../../../../../packages/contracts/src/crmBoard.ts";
export type { CrmCard as Card, CrmLane as Lane } from "../../../../../packages/contracts/src/crmBoard.ts";

/**
 * All money on the desk: each computer's
 * `/money/all` reply put together in one currency. The rules are shared with the phone and live in
 * contracts (allMoney.ts).
 */
export {
  chosenCurrency, toAskAgain, placedSpaces as placed, stackParts as stack, type PlacedSpace as Placed,
} from "../../../../../packages/contracts/src/allMoney.ts";

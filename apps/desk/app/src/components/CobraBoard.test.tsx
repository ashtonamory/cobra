import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPreview } from "./CobraBoard.tsx";

describe("Cobra's board card", () => {
  it("previews each widget with the rows it had, leaving out the lists a chart opens", () => {
    const board = {
      space: "happy-tails", spaceName: "Happy Tails", title: "Pipeline", describe: "Deals by stage.", reads: ["deals"], currency: "USD",
      views: [
        { id: "by-stage", title: "Deals by stage", kind: "chart", chart: { type: "bars", x: "stage", xKind: "text", series: [{ column: "deals", label: "Deals" }], drill: "at-stage" } },
        { id: "at-stage", title: "Deals", kind: "list", fromChart: true, row: { id: "id", title: "title" } },
        { id: "sizes", title: "By size", kind: "tiles" },
      ],
      preview: [
        { view: "by-stage", kind: "chart", title: "Deals by stage", rows: [{ stage: "Lead", deals: 3 }, { stage: "Won", deals: 1 }], masked: [], more: false, chart: { type: "bars", x: "stage", xKind: "text", series: [{ column: "deals", label: "Deals" }] } },
        { view: "at-stage", kind: "list", title: "Deals", rows: [], masked: [], more: false },
        { view: "sizes", kind: "tiles", title: "By size", tiles: [{ label: "Big", value: 2 }], masked: [], more: false },
      ],
    };
    const html = renderToStaticMarkup(<BoardPreview board={board} />);
    expect(html).toContain("Deals by stage");
    expect(html).toContain("Lead");
    expect(html).toContain("Big");
    expect(html.match(/class="chart-card"/g)?.length).toBe(2);
  });
});

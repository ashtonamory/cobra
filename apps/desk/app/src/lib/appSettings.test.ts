import { osOf, pickerShortcut, shortWhen } from "./appSettings.ts";

describe("appSettings", () => {
  it("reads the desktop from the user agent", () => {
    expect(osOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("macos");
    expect(osOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
  });

  it("writes the picker's shortcut as each desktop does", () => {
    expect(pickerShortcut("macos")).toBe("⌘⇧Space");
    expect(pickerShortcut("linux")).toBe("Super+P");
  });

  it("writes a change's time as the desk did", () => {
    expect(shortWhen(new Date(2026, 9, 9, 14, 5).getTime())).toBe("Oct 9 14:05");
    expect(shortWhen(new Date(2026, 0, 31, 9, 0).getTime())).toBe("Jan 31 09:00");
  });
});

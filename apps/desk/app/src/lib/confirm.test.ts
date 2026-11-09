import { describe, expect, it } from "vitest";
import { ConfirmPress, WINDOW_MS } from "./confirm.ts";

/** A clock the test moves by hand, in place of setTimeout. */
class Clock {
  now = 0;
  pending = new Map<number, [number, () => void]>();
  next = 1;

  schedule = (ms: number, fn: () => void): number => {
    this.pending.set(this.next, [this.now + ms, fn]);
    this.next += 1;
    return this.next - 1;
  };

  cancel = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  advance(ms: number): void {
    this.now += ms;
    const due = [...this.pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [handle, [at, fn]] of due) {
      if (at <= this.now && this.pending.has(handle)) {
        this.pending.delete(handle);
        fn();
      }
    }
  }
}

class Probe {
  clock = new Clock();
  runs = 0;
  finish: (() => void) | null = null;
  changes = 0;
  press = new ConfirmPress(
    (done) => {
      this.runs += 1;
      this.finish = done;
    },
    () => {
      this.changes += 1;
    },
    this.clock.schedule,
    this.clock.cancel,
  );
}

describe("ConfirmPress", () => {
  it("one press arms and does not run", () => {
    const p = new Probe();
    p.press.press();
    expect(p.press.armed).toBe(true);
    expect(p.runs).toBe(0);
  });

  it("two presses within the window run once", () => {
    const p = new Probe();
    p.press.press();
    p.clock.advance(WINDOW_MS - 1);
    p.press.press();
    expect(p.runs).toBe(1);
    expect(p.press.armed).toBe(false);
    expect(p.clock.pending.size).toBe(0);
  });

  it("it disarms after the window and the next press re-arms", () => {
    const p = new Probe();
    p.press.press();
    p.clock.advance(WINDOW_MS);
    expect(p.press.armed).toBe(false);
    p.press.press();
    expect(p.runs).toBe(0);
    expect(p.press.armed).toBe(true);
    p.press.press();
    expect(p.runs).toBe(1);
  });

  it("reset disarms", () => {
    const p = new Probe();
    p.press.press();
    p.press.reset();
    expect(p.press.armed).toBe(false);
    expect(p.clock.pending.size).toBe(0);
    p.press.press();
    expect(p.runs).toBe(0);
  });

  it("presses are ignored while the action runs", () => {
    const p = new Probe();
    p.press.press();
    p.press.press();
    expect(p.press.busy).toBe(true);
    p.press.press();
    p.press.press();
    expect(p.runs).toBe(1);
    expect(p.press.armed).toBe(false);
    p.finish!();
    expect(p.press.busy).toBe(false);
    p.press.press();
    expect(p.press.armed).toBe(true);
  });

  it("reset while busy keeps the action busy", () => {
    const p = new Probe();
    p.press.press();
    p.press.press();
    p.press.reset();
    expect(p.press.busy).toBe(true);
  });
});

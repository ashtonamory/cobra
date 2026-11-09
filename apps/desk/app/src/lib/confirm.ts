/**
 * Press again to confirm, with no dialog (the phone's `confirmPress.ts`; the desk's confirm.py).
 *
 * The first press arms for `windowMs`; a second press inside that window runs the action; if
 * nothing happens it disarms. While the action runs, presses are ignored. `reset()` disarms at once
 * (the page was left or unmounted).
 *
 * No timers here: they come in as `schedule(ms, fn) -> handle` and `cancel(handle)`, so a test can
 * move the clock by hand. The page passes setTimeout/clearTimeout.
 */

export const WINDOW_MS = 4000;

export class ConfirmPress {
  windowMs: number;
  armed = false;
  busy = false;
  private timer: unknown = null;

  constructor(
    /** `run(done)` starts the action and calls `done()` when it has finished, either way. */
    private readonly run: (done: () => void) => void,
    private readonly changed: () => void,
    private readonly schedule: (ms: number, fn: () => void) => unknown,
    private readonly cancel: (handle: unknown) => void,
    windowMs: number = WINDOW_MS,
  ) {
    this.windowMs = windowMs;
  }

  press(): void {
    if (this.busy) return;
    if (!this.armed) {
      this.armed = true;
      this.timer = this.schedule(this.windowMs, () => this.expire());
      this.changed();
      return;
    }
    this.disarm();
    this.busy = true;
    this.changed();
    this.run(() => this.done());
  }

  /** Disarm now. A running action is not stopped. */
  reset(): void {
    if (this.disarm()) this.changed();
  }

  private expire(): void {
    this.timer = null; // it has fired: nothing left to cancel
    this.reset();
  }

  private disarm(): boolean {
    if (this.timer !== null && this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = null;
    }
    const was = this.armed;
    this.armed = false;
    return was;
  }

  private done(): void {
    this.busy = false;
    this.changed();
  }
}

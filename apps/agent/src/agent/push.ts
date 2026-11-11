import { spawn } from "node:child_process";

import type { AlertPushData, ApiLanePushData, ApprovalPushData, MorningPushData, PushData } from "@cobra/contracts";

/**
 * Notifications on this computer's own desktop.
 *
 * Cobra runs on one computer and has no phone, so a "push" is a desktop
 * notification: `notify-send` on Linux, `osascript` on macOS. The watcher,
 * the alerts, the morning brief and the approval cards all call `sendPush`
 * with the one local recipient (`LOCAL_RECIPIENT`); nothing leaves the
 * machine. The desk shows the same items in its own popup, so a person who
 * keeps it open can turn these off with COBRA_NOTIFY=0.
 */

/** The one place a notification goes: this computer's desktop. */
export type Recipient = { token: string };

export const LOCAL_RECIPIENT: Recipient = { token: "desktop" };

export type PushMessage = {
  title: string;
  body: string;
  /** What the notification is about, for the event log and the desk. */
  data: PushData | AlertPushData | ApprovalPushData | ApiLanePushData | MorningPushData;
  /** The kind of notification (permission, approval, alert, ...). */
  category?: string;
};

export type PushOutcome = {
  /** Kept for the callers' shape; a desktop is never "dead". */
  dead: string[];
  /** Delivery failures, for the log. */
  errors: string[];
};

/** Whether desktop notifications are on (COBRA_NOTIFY=0 turns them off). */
export function notificationsOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.COBRA_NOTIFY !== "0";
}

/** The command that shows one notification on this platform, or null where there is none. */
export function notifyCommand(message: Pick<PushMessage, "title" | "body">, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | null {
  const title = message.title.slice(0, 200);
  const body = message.body.slice(0, 1000);
  if (platform === "linux") return { command: "notify-send", args: ["--app-name=Cobra", "--", title, body] };
  if (platform === "darwin") {
    // AppleScript string literals: escape backslashes and quotes; the text is passed as data, never as script.
    const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return { command: "osascript", args: ["-e", `display notification ${quote(body)} with title ${quote(title)}`] };
  }
  return null;
}

export async function sendPush(recipients: Recipient[], message: PushMessage): Promise<PushOutcome> {
  if (recipients.length === 0 || !notificationsOn()) return { dead: [], errors: [] };
  const shown = notifyCommand(message);
  if (!shown) return { dead: [], errors: [] };
  return new Promise((resolve) => {
    const child = spawn(shown.command, shown.args, { stdio: "ignore" });
    const timer = setTimeout(() => child.kill(), 8000);
    child.on("error", (caught) => {
      clearTimeout(timer);
      resolve({ dead: [], errors: [`${shown.command}: ${caught.message}`] });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ dead: [], errors: code === 0 ? [] : [`${shown.command} exited ${code}`] });
    });
  });
}

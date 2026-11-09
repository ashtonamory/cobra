import { z } from "zod";

/**
 * Sending a file somewhere: a share from WhatsApp (or Files, or Photos) to one
 * of Sam's repositories, to machines in the fleet, or both.
 *
 * The Mini is the relay. The phone uploads each file to it once, then posts a
 * send naming where the files should go; the Mini commits to GitHub through
 * the API (so any repository works, checked out anywhere or nowhere) and hands
 * a copy to each machine, holding it until a sleeping one comes back.
 *
 * Statuses are strings rather than enums for the reason gotcha 18 gives: an
 * older app must not reject a whole list over a state added later.
 */

/** What `POST /files/upload?name=` answers with. The body is the file's raw bytes. */
export const FileUpload = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  uploadedAt: z.string(),
});

export const SendRequest = z.object({
  /** Upload ids, in the order they should be listed. */
  files: z.array(z.string()).min(1),
  /** "owner/name". Omitted: no repository. */
  repo: z.string().optional(),
  /** Hostnames as `os.hostname()` prints them ("omarchy", "mini"). */
  devices: z.array(z.string()).optional(),
});

export const SendFile = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int(),
});

export const RepoDelivery = z.object({
  repo: z.string(),
  /** "pending" | "done" | "failed" */
  status: z.string(),
  branch: z.string().optional(),
  /** Where the files landed, e.g. ["inbox/invoice.pdf"]. */
  paths: z.array(z.string()).optional(),
  pr: z.object({ number: z.number().int(), url: z.string() }).optional(),
  error: z.string().optional(),
});

export const DeviceDelivery = z.object({
  host: z.string(),
  /** "queued" | "delivered" | "failed" | "expired" */
  status: z.string(),
  attempts: z.number().int(),
  lastError: z.string().optional(),
  deliveredAt: z.string().optional(),
  /** Where each file was written on that machine. */
  paths: z.array(z.string()).optional(),
});

export const SendRecord = z.object({
  id: z.string(),
  createdAt: z.string(),
  files: z.array(SendFile),
  repo: RepoDelivery.optional(),
  devices: z.array(DeviceDelivery),
});

export const SendList = z.object({
  sends: z.array(SendRecord),
  /** The machines a send may name, as hostnames, so the app need not hard-code them. */
  devices: z.array(z.string()),
  maxBytes: z.number().int(),
});

/** What `POST /files/receive` answers with on the machine that got a copy. */
export const ReceivedFile = z.object({
  path: z.string(),
  size: z.number().int(),
});

/**
 * Rides in a files push ("pr-opened", "delivered", "failed"). The app routes
 * any payload carrying `files` to the Sent files screen.
 */
export const FilesPushData = z.object({
  machine: z.string(),
  files: z.string(),
  kind: z.string(),
  url: z.string().optional(),
});

export type FileUpload = z.infer<typeof FileUpload>;
export type SendRequest = z.infer<typeof SendRequest>;
export type SendFile = z.infer<typeof SendFile>;
export type RepoDelivery = z.infer<typeof RepoDelivery>;
export type DeviceDelivery = z.infer<typeof DeviceDelivery>;
export type SendRecord = z.infer<typeof SendRecord>;
export type SendList = z.infer<typeof SendList>;
export type ReceivedFile = z.infer<typeof ReceivedFile>;
export type FilesPushData = z.infer<typeof FilesPushData>;

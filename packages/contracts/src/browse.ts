import { z } from "zod";

/**
 * Looking at a computer's files from the phone: a folder's contents, one
 * file's bytes, a name search, and a file sent into a folder. Everything is
 * under the home folder of the user the agent runs as, and never one of the
 * secret paths the agent keeps out of reach (agent browse.ts isSecret).
 *
 * `kind` is a string rather than an enum for gotcha 18's reason: a kind added
 * later must not fail an older app's whole listing.
 */

export const FsEntry = z.object({
  name: z.string(),
  /** "dir" | "file" | "other". A symlink is the kind of what it points to. */
  kind: z.string(),
  /** Bytes; 0 for a folder. */
  size: z.number(),
  /** ISO time of the last change. */
  modifiedAt: z.string(),
  /** A dot name. The app shows these behind a toggle. */
  hidden: z.boolean(),
  /** True when the entry is a symlink. */
  link: z.boolean().optional(),
});

/** What `GET /fs/list?path=` answers with. */
export const FsListing = z.object({
  /** The folder, absolute, symlinks resolved. */
  path: z.string(),
  /** The home folder, so the app can show `~` and stop the breadcrumbs there. */
  home: z.string(),
  /** The folder above, or null at home. */
  parent: z.string().nullable(),
  /** Folders first, then files, by name. */
  entries: z.array(FsEntry),
  /** True when the folder had more entries than one listing carries. */
  truncated: z.boolean(),
});

export const FsHit = FsEntry.extend({
  /** Absolute path of the match. */
  path: z.string(),
});

/** What `GET /fs/search?path=&q=` answers with. */
export const FsSearch = z.object({
  path: z.string(),
  query: z.string(),
  results: z.array(FsHit),
  /** True when the search stopped early (too many matches, folders or seconds). */
  truncated: z.boolean(),
});

/** What `POST /fs/put?path=<folder>&name=` answers with. The body is the file's raw bytes. */
export const FsPut = z.object({
  path: z.string(),
  size: z.number().int(),
});

export type FsEntry = z.infer<typeof FsEntry>;
export type FsListing = z.infer<typeof FsListing>;
export type FsHit = z.infer<typeof FsHit>;
export type FsSearch = z.infer<typeof FsSearch>;
export type FsPut = z.infer<typeof FsPut>;

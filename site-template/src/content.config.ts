// Posts come from the staged folder build.mjs writes (drafts left out, each
// already checked by validatePost), never from the template itself.
import { pathToFileURL } from "node:url";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const base = pathToFileURL(`${process.env.COBRA_POSTS_DIR}/`);

export const collections = {
  posts: defineCollection({ loader: glob({ pattern: "*.md", base }) }),
};

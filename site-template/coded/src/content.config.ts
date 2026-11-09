// The site's posts: src/content/posts/<slug>.md, written by Cobra (site_edit {post}) from the
// person's words. Front matter: title, date (YYYY-MM-DD), optional description and draft.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: "[a-z0-9]*.md", base: "./src/content/posts" }),
    schema: z.object({ title: z.string(), date: z.string(), description: z.string().optional(), draft: z.boolean().optional() }),
  }),
};

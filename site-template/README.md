# Space website template

One Astro template that builds every Space's website from data
, and design mode, which builds a site from its own
templates (below). The Website Builder Foreman edits only the Space's
`site.json`, its `posts/*.md` and its `images/`; this folder is never edited
per site.

```bash
npm ci                                     # once; Astro is pinned exactly
node build.mjs --site <dir> --out <dir> [--brand <dir>] [--url https://…] [--turnstile <sitekey>]
node build.mjs --site <dir> --check        # the checks only
npm test                                   # the build check, over example/
```

- **The shape** is `packages/contracts/src/website.ts` (`validateSite`,
  `validatePost`), imported by relative path with no zod, so the agent can
  ship it as it ships `views.ts`. Every problem is reported with its path.
- **Ten sections**: hero, services, prices, testimonials, gallery, faq,
  contact, hours, booking, posts (`src/sections/`). Text is plain and
  escaped; a blank line starts a paragraph. Posts are Markdown with no raw
  HTML, links only to https, mailto, tel or the site, images only from
  `/images/`. A draft is left out.
- **Brand kit**: the Designer's `brand/brand.json` (four colours, two of the
  shipped fonts, the logo) becomes `/brand.css` (`theme.mjs`). Text on
  the brand and accent colours takes whichever colour reads at 4.5:1. Fonts
  are the Designer's, as woff2 in `fonts/` (OFL, `fonts/licenses/`); only
  the two the brand names are copied.
- **No script, no inline style**: `_headers` sets a CSP of `default-src
  'none'` plus self for images, styles, fonts and the form. The contact form
  posts to `/api/inquiry`, the site Worker's route (Phase 4); `company` is a
  honeypot. With `--turnstile <sitekey>` (Phase 4b) the form shows
  Cloudflare's spam check, its script is the only one on the site (on pages
  with the form), and the CSP adds exactly `script-src` and `frame-src`
  `https://challenges.cloudflare.com`. `site.json`'s `form` (where inquiries
  are emailed) is never rendered.
- **Output**: only the images the site uses, the two fonts, `robots.txt`,
  and with `--url` canonical links and `sitemap.xml`. A build replaces its
  out folder only when that folder is empty or holds `.assetsignore`, which
  every build writes and Wrangler never uploads.
- **Where it runs**: each build stages in `.builds/<random>/` inside this
  folder and runs from there (Astro's prerendered chunks import its
  packages from `node_modules`, and stage under the working directory), so
  the folder must be writable. Astro also writes its types to `.astro/`.
  One build per process: it sets `process.env` and the working directory.

## Design mode

A site folder with `design/` builds in design mode (`design.mjs`): its own look, built from the concept
the person picked, with no Astro and no code of the site's own.

- **Files**: `content.json` (every word; `name` and `description` required,
  `form`, `pages`, `icon`, `shareImage`, `themeColor` optional; `page` and
  `site` are the build's), `design/pages/<name>.html` (`index` is `/`, `404`
  is `/404.html`, any other is `/<name>/`; `thanks` is where the form lands),
  `design/partials/*.html`, `design/site.css` (served as `/site.css?v=<hash>`),
  `design/fonts/*` with a licence beside them, `design/concept/` (the Tessel
  file and renders, kept and never served), and `images/` (only what a page or
  the stylesheet names is copied).
- **Templates** are Mustache 4.2.0 with escaping always on: no `{{{ }}}`,
  `{{& }}` or delimiter change, and an attribute holding a `{{value}}` is
  double-quoted, so no word in `content.json` becomes markup.
- **Cobra's partials**: `{{> head}}` (title, description, canonical, Open
  Graph, icon, theme colour, the stylesheet) and `{{> form}}` (`form.kind`
  `waitlist` or `inquiry`, the fields the site Worker reads, the honeypot,
  Turnstile and its script with `--turnstile`). A design styles them by class
  (`.form`, `.form-waitlist`, `.field`, `.trap`, `.cf-turnstile`) and may not
  name a partial of its own `head`, `form` or `form-guard`.
- **A design's own forms**: `content.json` `forms` declares each one
  (`{<id>: {title, kind?, fields: [{name, type, label?, required?, options?,
  value?}]}}`, `FIELD_TYPES`, one `email` field each, at most `FORM_LIMITS`).
  The design writes and styles the `<form method="post"
  action="/api/form/<id>">` itself with `{{> form-guard}}` inside (the
  honeypot and, with `--turnstile`, the check; its script is added once before
  `</body>`). The build refuses a name the form's fields lack, a field with no
  control, a hidden field on the page, or a form without the guard, and writes
  the checked forms to `_forms.json` (left off the site) for the site Worker.
- **The lint**, on each template and again on each rendered page: no
  `<script>` (but Turnstile's), `<style>`, `<iframe>` and kin, `style=` or
  `on…=`, `<meta>`/`<link>` outside Cobra's partials, a `<form>` that is not one of the above; links only to
  the site's own paths, `#anchors`, `https:`, `mailto:` and `tel:`; images only
  from `/images/`. In `site.css`: no `@import`, `url()` only to `/fonts/` and
  `/images/`; every `font-family` (and `font` shorthand, custom properties
  followed) must start with a generic family or one with an `@font-face`
  whose file is in `design/fonts/` (`fontProblems`), so no page falls back to
  a stand-in font. Sizes are capped (`DESIGN_LIMITS`). Posts are not built in design
  mode yet.
- **Example**: `example-design/` is Corner Bakery's concept A, built from its
  Tessel concept (spikes/website-design/); `npm test` builds it and the lint
  cases.

## The site check

`node check.mjs --out <dir> --shots <dir> [--json]` opens what build.mjs wrote in a real browser before anyone is asked
to put it live: served on 127.0.0.1 with its own `_headers`, so the CSP is
Cloudflare's, every page and a missing one at desktop (1440) and phone (390)
width, Turnstile's script answered empty so nothing leaves the computer. It
lists console, page and CSP errors, failed or outside requests, images and
fonts that did not load, a page wider than the window and pixel art
(`img.pixel` or `image-rendering: pixelated`) drawn at an uneven scale, and
keeps a full-page JPEG per page and width (`home-desktop.jpg`, cut at 7200
pixels). Chromium is the agent's headless shell (`CHROMIUM`, set by the agent's
site.ts), else the computer's own; none is exit 2 with what to install.
`playwright-core` is pinned in package.json and ships with the package.
`npm test` runs it on the example design (skipped without Chromium).

Not in the pnpm workspace and not in `pnpm check`, like `apps/desk`: npm with
its own lockfile. The agent package will ship it with its `node_modules` and
`packages/contracts/src/website.ts` beside it (Phase 3).

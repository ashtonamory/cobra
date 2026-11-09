# A Cobra coded site

This is a real Astro site. Cobra's Website Builder keeps it, and a Worker writes its code. It is built
inside Cobra's sandbox with no network, and the person allows every change on a website card before
it goes live.

## Building the concept

The person picked one of the Designer's concepts. A Worker of this site finds it in its own worktree,
in `.cobra-attachments/concept/` (git ignores that folder):

- `concept-desktop.png` (1440 wide) and `concept-phone.png` (390 wide): what the home page must look like.
  Open them, and build to match them: layout, type sizes, weights, line heights, letter spacing,
  whitespace and colours. Never a look of your own.
- `code/desktop/` and `code/phone/`: Tessel's export of the two frames, as HTML and CSS. Read them for the
  exact sizes, colours and spacing. Never copy them in whole: turn them into Astro pages and components,
  with one stylesheet that scales from the phone's sizes to the desktop's (`clamp()`, media queries).
- `*.tessel.json` and its `.assets/` folder: the design itself and its images. Copy the images the
  concept uses into `public/images/`.

The concept's fonts are already in `public/fonts/`, from Cobra's web fonts, with their licences. Add an
`@font-face` for each one you use. Every word, price, time and link comes from `src/content/site.json`:
put the concept's words there, and leave out a placeholder the person has not given real words for.
Run `npm run build` before you finish. Cobra's local check runs `npm run check` on every PR, which builds the site the same way: keep that script.

## The rules

- **Static files only.** `output: "static"`. There is no server code, API route or middleware. The
  site's own Worker (Cobra's) answers `/api/inquiry` and serves the files.
- **The words live in `src/content/site.json`.** Its schema is `src/content/site.schema.json`. The
  person changes the words by chat, and Cobra edits only that file, so pages read every fact
  (name, prices, hours, links) from there and never type one in. If a page shows a new kind of fact,
  add it to the schema and to `site.json` first.
- **`src/components/cobra/` is Cobra's.** Include `Head.astro` in every page's `<head>`, use
  `Form.astro` for every form and `Posts.astro` wherever the site lists its news. Never change them.
  Style them through their classes.
- **Every form is Cobra's `Form`, and its answers go to the person's People by themselves.** The
  contact form is `<Form />` (or `<Form kind="waitlist" />`). A form with the person's own questions
  (a booking, a quote, a sign-up) is declared in `src/content/forms.json` and drawn with
  `<Form form="book" />`:

  ```json
  { "book": { "title": "Table booking", "fields": [
    { "name": "name", "type": "text", "required": true },
    { "name": "email", "type": "email", "required": true },
    { "name": "party_size", "type": "number", "label": "Party size", "required": true },
    { "name": "seating", "type": "radio", "options": ["Inside", "Harbour side"] }
  ] } }
  ```

  Types: `text`, `email`, `tel`, `number`, `date`, `textarea`, `select` and `radio` (with `options`),
  `checkbox` (a pick-several with `options`, a tick box without, or the email consent box with
  `topic`), and `hidden` (with `value`, which the site sends itself). Each form has one `email`
  field, at most 20 fields, and an id like `book` or `quote-request`. The site's Worker keeps only
  the declared fields; name, email and phone go on the person, and every other answer goes in the
  Space field named by its label. Never post a form anywhere else, and never use a form service.
- **Posts are Cobra's too.** Cobra writes `src/content/posts/<slug>.md` from the person's words;
  the pages are `src/pages/posts/`. Never write a post in code.
- **Keep `src/pages/404.astro` and `src/pages/thanks.astro`.** A sent form lands on the thanks page.
- **Outside services go in `cobra.json`.** Each one is `{name, why, hosts, kinds}`; `why` is one short sentence the person reads on the card, such as "The map on the Contact page." The kinds are
  `frame`, `script`, `style`, `image`, `font`, `media` and `connect`. The website card shows each
  service to the person, and the site's security rules let in exactly those hosts for exactly those
  kinds. Any other outside address stops the build. A link the visitor clicks is not a service.
- **Scripts.** Scripts go in `<script>` tags or islands, never in `onclick=` style attributes or
  `javascript:` links. Cobra allows each script the build makes by its hash. Never use `eval` or
  `new Function`.
- **Cobra writes the host files.** Never add `_headers`, `_redirects`, `robots.txt` or `sitemap.xml`
  to `public/`.
- **Images.** Images go in `public/images/`, ready-sized, at most 10 MB each and 50 MB for the whole
  site. Nothing resizes them at build time.
- **Fonts.** Copy fonts into `public/fonts/` and add an `@font-face` for each. Cobra's own web fonts
  need no licence file. A font from anywhere else needs its licence beside it.

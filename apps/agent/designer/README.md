# The Designer's files

What the Designer trade (`src/agent/designer.ts`) hands Tessel; `package.sh` ships this folder.

- `templates/`: the post templates, 1080 x 1350, and `website.tessel.json`, the starter for a website concept (Desktop 1440 and Phone 390, columns of auto-layout sections). Made by `scripts/designer-templates.py`: change the script and run it again rather than editing the JSON.
- `fonts/`: the fonts a brand kit chooses from (`BRAND_FONTS`), loaded by Tessel with `--fonts`, never installed on the computer. All from [Google Fonts](https://github.com/google/fonts) under the SIL Open Font License 1.1; each family's licence is in `fonts/licenses/`.

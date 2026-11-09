# The STE dictionary

`dictionary.json` goes here: the approved-word dictionary from ASD-STE100
Issue 9, extracted from Sam's own copy of the specification. Request the
specification from https://www.asd-ste100.org.

ASD holds the copyright. The file lives in this repo only while the repo is
private: move it out of git before the repo is ever made public, and never
bundle it into anything that leaves this repo (the app bundle, the agent
package, a published artifact).

Until the file is here, the checker runs without it: the sentence, voice and
procedure checks work, and the word checks (W1, V1, N1) are skipped. The
check result says so (`dictionary: false`).

## Format

An array of entries, as `DictionaryEntry` in `src/dictionary.ts` describes.
The values below show the shape only; they are not quoted from the
specification.

```json
[
  { "word": "start", "pos": "verb", "approved": true, "forms": ["starts", "started"] },
  { "word": "commence", "pos": "verb", "approved": false, "use": ["start"] },
  { "word": "make sure", "pos": "verb", "approved": true }
]
```

- `forms` lists every other approved form. Noun plurals are added
  automatically; an inflection that is not listed is a V1 violation.
- A word that is not approved carries `use`, the approved words that replace
  it. Its regular inflections are not approved either.
- Multi-word entries are matched as phrases, longest first.

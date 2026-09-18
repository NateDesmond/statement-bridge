# Contributing

Thanks for looking at Statement Bridge. Small, focused pull requests are
easiest to review.

## Before you start

- Read `README.md` and `docs/PRD-SUMMARY.md` for the shape of the app.
- For a bug fix: reproduce it with a test first if you can, then fix the
  root cause (check every caller of the function you're touching, not just
  the path a report names).
- For a new statement-type capability (a parsing shape no built-in covers):
  add a synthetic fixture under `extension/test/fixtures/` (generate it with
  a script under `extension/test/fixtures/gen/` where practical), a starter
  profile in `extension/src/core/builtin-profiles.js`, and a regression
  test. **Never name a real bank** in a fixture, a builtin profile, test
  data, or a code comment - use a fictional bank name instead (see the
  existing ones: Meridian Bank, Harbour Card, Riverside Bank, Summit Bank,
  Anchor Bank, Lattice Bank, Northwind Bank, or invent another clearly
  fictional one). This keeps the repository from ever shipping a real
  bank's export layout as a "default", and keeps test data free of
  anything that looks like a real account.
- Never commit real personal data: no real statements, no real account
  numbers, no real names in fixtures or comments.

## Style

- No em dashes anywhere in code, comments, or copy.
- No "honest", "genuine", "truthful" (or close variants) in user-facing
  copy or comments.
- Plain words in anything the user sees: "statement type" not "profile",
  "text recognition" not "OCR".

## Running things locally

```
cd extension
node --test test/*.test.js
node dev/gate.mjs --fast
```

The full gate (`node dev/gate.mjs`, no `--fast`) also runs the OCR and
synthetic-corpus recall audits; it's slower and not required for every PR,
but should stay green before a release.

## Pull requests

- Keep `node dev/gate.mjs --fast` green.
- Describe what you changed and why, not just what.
- If you touched anything under `extension/src/core/`, add or update a
  test in `extension/test/`.

## Reporting a security issue

Please don't open a public issue for a security vulnerability - see
`SECURITY.md`.

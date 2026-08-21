# Exercise Tracker — PWA (Firebase)

Installable PWA version of the exercise tracker, backed by Firebase Firestore.

This is a separate, independent branch from `main` — the working Google
Sheets + Apps Script version stays untouched there as a fallback until this
version is confirmed working.

**Status: app shell built, backed by Firestore.** Not yet deployed or
seeded with real data — see "Remaining steps" below.

## Data model

Two Firestore collections, mirroring the old Plan/Log sheets:

- `plan` — one document per plan version (Version, ValidFrom, Day, Session,
  Exercise, Sets, Reps, Duration, Weight, Order, Active). Editing an
  exercise deactivates the old doc and adds a new version, same as before.
- `log` — one document per date+session+exercise, with a deterministic ID
  (`{date}_{session}_{slugified-exercise}`) so logging/un-logging is a
  simple upsert/delete instead of a row search.

All the plan-resolution, implicit-skip, and dashboard logic from the old
`Code.js` was ported into `js/app.js` unchanged; only the storage layer
changed. The 3-second debounced sync queue was replaced with direct
Firestore writes (fired optimistically, tracked by the same spinner/check
indicator) since Firestore's client SDK is fast enough not to need batching.

## Remaining steps

1. Confirm Firestore Security Rules are published (open access is fine —
   this is a single-user app with no real access control needed).
2. Migrate existing Plan/Log data from the Google Sheet into Firestore.
3. Enable GitHub Pages for this branch (Settings → Pages → Deploy from
   branch → `pwa`).

## Deployment

Served via GitHub Pages from this branch.

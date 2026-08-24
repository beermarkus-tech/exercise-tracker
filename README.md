# Exercise Tracker — PWA (Firebase)

Installable PWA version of the exercise tracker, backed by Firebase Firestore.

This is the current, primary version of the app, deployed via GitHub Pages
from this branch. `main` holds the original Google Sheets + Apps Script
version, kept around as a historical fallback but no longer actively used.

**Status: live and in daily use**, seeded with the real Plan/Log history
migrated from the Sheet.

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

## Deployment

Served via GitHub Pages from this branch.

# PR #244 queue UX evidence

- `before/` — base `1d6fcdf719932cefa2943465555b2e95301750bb` (merge of the PR head and dev `433f1f51`)
- `final/` — head `f685e5b23900039649896e207fe38e11b0336fda` (six widths, idle/running, collapsed, scroll, toast)
- `receipts/` — `f685e5b2` → `3c7cfa4a5be87163d5c1e1c6f4ed39903a79dade` (queue header counts receipts: `0 queued` → `2 messages`)

Same fixture (`frontend/tests/visual/fixtures/data.mjs`), frozen clock `2026-08-15T12:00:00.000Z`, DPR 2, Chromium headless.
Queue/dispatch payloads are route-intercepted, not produced by a real server.

# Yamzo checkout-state integrity hotfix — 2026-08-17

## Outcome

Ship a verified GitHub hotfix that immediately unlocks payment after a successful Unpaid Bill print, keeps the order workspace open during repeat-print confirmation, restores every checkout input in its designated field, and opens the POS maximized reliably.

## Execution packets

- [x] Reproduce and map the stale bill state, repeat-print dialog dismissal, and discount hydration paths.
- [x] Persist the cashier's discount mode, raw discount entry, and manual total additively, with migration backup coverage and safe legacy fallback.
- [x] Centralize checkout draft hydration so new, edited, printed, retried, and resumed orders share one state update path.
- [x] Prevent nested confirmation clicks from dismissing the parent order workspace.
- [x] Add regression tests for percent, flat-TK, manual-total resume fidelity and legacy fallback.
- [x] Verify TypeScript, full tests, build/package, immediate payment unlock, repeat-print retention, refreshed Open Orders state, panel overflow, renderer errors, and native maximized startup using disposable Test Mode data.
- [ ] Secret-scan, commit, push branch, fast-forward GitHub `main`, and verify parity.

## Safety gates

- Discount money remains an absolute whole-TK amount for receipts, reports, and payment calculations.
- New metadata stores only presentation intent (`percent` or `tk`) and the cashier's raw numeric entry; legacy orders default to flat TK without changing stored totals.
- Schema change is additive, increments the local schema version, and triggers the existing automatic pre-migration SQLite backup.
- No production/store database or physical printer is used during testing; Test Mode and a disposable app-data directory remain mandatory.
- No completed/cancelled order mutation, deletion, or reopen behavior changes.

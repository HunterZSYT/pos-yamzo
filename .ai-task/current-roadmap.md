# Yamzo payment, reports, history, and timer release — 2026-08-17

## Outcome

Ship a verified GitHub update that makes payment source an explicit Cash / bKash / Multi choice, records split cash+bKash allocations accurately, lets Foodpanda and Foodie complete after mandatory KOT and external ID without bill/payment-slip gates, confirms every completion with a summary modal, adds date filters to completed/cancelled orders, simplifies register reporting into distinct Cash/bKash/Foodpanda/Foodie totals, and permanently stops all timers for completed/cancelled orders including migrated history.

## Execution packets

- [x] Recovery and recon: verify clean GitHub `main`, recover release boundaries, map payment/schema/report/history/timer blast radius, and create a release branch.
- [x] Payment contract: add additive split-tender persistence and receipt/report allocations while preserving existing payment history.
- [x] Platform flow: enforce mandatory external ID plus KOT for Foodpanda/Foodie, bypass unpaid/paid bill and payment-source gates, and retain accurate platform sales reporting.
- [x] Checkout UI: replace the payment dropdown with required Cash/bKash/Multi selection boxes, show simple tender inputs, and add completion-summary confirmation.
- [x] History and reports UI: add date filters to completed/cancelled orders and surface clear Cash, bKash, Foodpanda, and Foodie register totals without mixing parcel payments by order source.
- [x] Timer repair: stop order and batch timers on completion/cancellation and migrate already closed orders/tickets to finite completion timestamps.
- [x] Verification: migration safety, targeted and full tests, TypeScript, build, installer, packaged smoke, and one targeted rendered Electron inspection with printing bypassed.
- [x] Release: inspect the exact diff, secret-scan, commit the `codex/` branch, push, merge to `main`, push GitHub, and verify local/remote parity.

## Safety gates

- SQLite changes are additive and migration-tested against existing WAL data; no production database connection or destructive reset.
- Existing payment/order/audit rows remain retained; payment redo continues to preserve its audit record.
- Public Live Ordering remains disabled and no cloud authority or production routing changes are part of this release.
- Physical printer output is not claimable on this PC; verify durable job content and bypass only the print transport in tests.
- Stop after two failed verification attempts on the same path and record the next diagnostic.

## Business invariants

- Cash in reports equals the applied cash portion after change, never the full value of parcel/in-house orders paid by bKash.
- Multi payment must exactly cover the payable total through bKash plus applied cash; cash tendered may exceed its applied portion only to produce change.
- Foodpanda/Foodie sales belong to their platform totals and never inflate Cash or bKash.
- No order can complete until every required KOT is printed; Foodpanda/Foodie additionally require an external platform ID.
- Closed orders and all their kitchen batches always have a finite stop timestamp and remain non-editable.

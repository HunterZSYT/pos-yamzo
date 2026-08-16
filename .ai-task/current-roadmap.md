# Yamzo critical store checkout release — 2026-08-16

## Outcome

Ship a verified GitHub update that enforces occupied-table locking, explicit whole-order table transfer, mandatory automatic KOT for every local order type, distinct audited post-KOT Swap and Cancel actions, the required unpaid-bill-before-payment checkout sequence, paid-slip auto-print, manager-authorized payment redo, immutable completed orders, and two-line receipt address formatting.

## Execution packets

- [x] Recovery: confirm clean `main`, remote/auth state, prior Gate 3/6 ledgers, screenshots, and current SQLite/Electron architecture.
- [x] Domain and schema: map and implement enforceable order, table, KOT, adjustment, payment-redo, completion, and audit invariants using additive local SQLite upgrades only.
- [x] Renderer: expose locked occupied tables, explicit Change Table, mandatory KOT states, distinct Swap/Cancel controls, and the five-stage checkout UI.
- [x] Receipts: make unpaid Bill Copy precede payment, auto-queue a Paid Slip on Record Payment, include paid/discount/change summary, and constrain the address to two lines.
- [x] Automated verification: add regression coverage, then run TypeScript, tests, build, package, and packaged smoke.
- [x] Rendered verification: use a disposable `YAMZO_APP_DATA_DIR`; confirm packaged login/new audit navigation in Electron/CDP, with checkout state transitions proven through transport-bypassed automated tests.
- [x] Release: inspect the exact diff, commit on a `codex/` release branch, push, merge to `main`, push `main`, and verify local/remote parity.

## Safety gates

- Do not connect to or mutate a production database; this task uses only the app's local SQLite schema and disposable QA data.
- Do not enable Public Live Ordering or route LIVE traffic to this PC.
- Do not print secrets, credentials, PIN hashes, or environment values.
- Physical Xprinter output is not claimable on this PC; verify print-job content and transport-bypassed state, leaving paper/cut verification for the store PC.
- Stop after two failed verification attempts on the same path and record the next diagnostic.

## Single-risk items

- Existing store SQLite data must upgrade additively without losing orders or print/audit history.
- GitHub `main` is the update surface requested by the user; only merge after all local release gates pass.

# Yamzo payment-panel and local admin controls — 2026-08-17

## Outcome

Ship a verified GitHub update that removes horizontal overflow from Payment & Close, adds a per-PC Test Mode that bypasses physical print transport while preserving normal print-state workflow, and adds a password-confirmed reset for inventory usage, restocks, and physical counts only.

## Execution packets

- [x] Recon: inspect the screenshot, rendered panel structure, print boundary, settings APIs, admin authorization, inventory schema, and existing reset patterns.
- [x] Payment panel: contain every card/control at narrow desktop panel widths, remove the horizontal scrollbar, and keep primary actions readable.
- [x] Local Test Mode: persist an off-by-default per-PC flag, surface it in Admin, and short-circuit physical printing only at the centralized print boundary while recording successful test attempts.
- [x] Inventory activity reset: require current admin password plus `RESET INVENTORY ACTIVITY`, clear usage adjustments, restock history, and physical counts transactionally, and preserve every catalog, recipe, price, cost, and order record.
- [x] Verification: TypeScript, targeted and full tests, build, disposable Electron UI inspection at the reported width, accessibility/overflow checks, and test-mode workflow proof.
- [x] Release: secret-scan, commit a `codex/` branch, push, fast-forward `main`, push GitHub, and verify parity.

## Safety gates

- Test Mode defaults off and is stored in each PC's local SQLite settings; updating the store PC cannot enable it.
- Test Mode skips only the physical transport. Print jobs, attempts, KOT requirements, and auditability remain intact.
- Inventory reset runs in one SQLite transaction and deletes only `inventory_adjustments`, `inventory_restock_entries`, and `inventory_physical_counts`.
- Inventory items, categories, units, recipes, bindings, price history, costs, orders, order items, payments, print jobs, and order cost snapshots remain unchanged.
- Public Live Ordering and production website authority remain unchanged.

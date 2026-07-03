# Yamzo Inventory Completion Roadmap

## Summary
Bring Inventory, Costs, Physical Count, Restock, Recipe Backfill, and Audit behavior back in line with the attached instructions. Preserve production data and make only additive/reversible schema changes.

## Completed Or Mostly Done
- [x] Inventory has Status, Recipes, Items, Restock, Physical Count, Orders, Audit Log, and Settings tabs.
- [x] Items support base unit/category setup, create/edit/remove, CSV import, cards, and price history.
- [x] Recipes support card listing, search/filtering, raw ingredients, nested recipe materials, restock/use-in-recipe flags, and picker flow.
- [x] Restock has history-first UI, Add Restock modal, raw/recipe material filter, card picker, purchase vs stock adjustment mode, edit/delete, and audit activity.
- [x] Costs exists as a separate left-nav panel with Status/Settings, category CRUD/reorder, add record, date filters, and CSV export.
- [x] Completed-order recipe usage snapshots and backfill/recalculation APIs exist.
- [x] Inventory Audit Log tab exists and reads activity logs.

## Partially Done But Needs Fixing
- [x] Recipe save flow offers future-only vs selected-range backfill.
- [x] Backfill controls moved out of Inventory Orders and into contextual recipe save/recalculation flow.
- [x] Restock has count status, six-hour stale-count admin override, and clearer material separation.
- [x] Physical Count has edit/delete CRUD, admin password/reason, and audit old/new values.
- [x] Costs has record edit/delete CRUD and Qty removal.
- [x] Audit Log has search, date, user/action filters, and export.
- [x] Status tab has stock movement columns and hides Expected Left by default.
- [x] Orders tab is a simpler operational usage audit with filters/export/source grouping.

## Not Done Yet
- [x] Remove global Inventory KPI cards and show tab-specific summaries only.
- [x] Add physical-count edit/delete APIs, preload bindings, UI, reason prompts, and audit entries.
- [~] Add recipe-material physical count eligibility and blind staff count flow. Current Add Count uses raw item cards; recipe-material count UX still needs a clearer dedicated path.
- [x] Add physical-count freshness status needed by Restock.
- [~] Add restock card states: Never Counted, Counted Recently, Count Expired, Password Unlock Used. Current UI shows recent/expired/never; password unlock is recorded as protected access plus note.
- [x] Add restock admin unlock with reason.
- [x] Ensure deleting all restocks resets latest restock values through live restock-derived latest-price/quantity calculations.
- [x] Remove accidental physical-count side effects from normal restock if conflicting with count source of truth.
- [~] Add recipe save preview with old usage, new usage, and delta. Current preview is summary-level through existing API.
- [~] Apply missing usage or delta correction only, never duplicate full deductions. Existing modes are available; row-level delta preview remains pending.
- [x] Support nested recipe recalculation through selected date range through existing range backfill/recalculation.
- [x] Rebuild Costs with system subtabs, Raw Materials Restock Bank, search/date filters, and PDF export. System categories now render as hard tabs; custom categories stay in a selector.
- [x] Improve Reports with date-range source totals, payment totals, raw-material usage, cost records, and PDF export content.
- [x] Remove Missing Recipes and profit/net-income accounting from Reports.
- [~] Expand Audit Log to cover exports, expected-left reveal, unlocks, physical count CRUD, and cost CRUD. Current log covers filters/export/unlocks/count/cost CRUD; expected-left reveal is pending.

## Implementation Order
1. Roadmap Sync.
2. Physical Count Packet.
3. Restock Packet.
4. Recipe Backfill Packet.
5. Costs Packet.
6. Inventory Status / Orders / Audit Packet.

## Verification
- [x] npm run lint
- [x] npm run test
- [x] npm run build
- [x] npm run package
- [x] npm run smoke:packaged

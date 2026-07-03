# Inventory Remaining Packet

Goal: Finish the accepted Yamzo Inventory Completion Roadmap without deleting production data.

Hard constraints:
- Preserve runtime/order/menu/inventory data.
- Schema changes must be additive or reversible-by-code.
- Completed orders use saved recipe/material snapshots.
- Recipe recalculation/backfill must be explicit and auditable.
- Physical count and restock changes must require admin reason when editing/deleting/unlocking.
- UI should use the existing component system and avoid cramped dropdown-heavy flows.

## Done
- [x] Nested recipe-material support through `recipe_child_ingredients`.
- [x] Completed-order inventory preview/backfill/range recalculation APIs.
- [x] Per-order inventory usage recalculation.
- [x] Inventory Audit Log tab sourced from existing audit records.
- [x] Tests for nested recipes and order usage recalculation.
- [x] Physical Count edit/delete APIs, preload bindings, UI actions, admin password/reason prompt, and audit records.
- [x] Costs record edit/delete APIs, preload bindings, UI actions, admin password/reason prompt, and audit records.
- [x] Removed Qty from Costs UI and cost record types.
- [x] Removed silent physical-count creation from normal restock purchases.
- [x] Added count status badges and six-hour stale-count admin unlock prompt to Restock.
- [x] Moved global Orders-tab backfill controls into contextual Recipe Editor post-save flow.
- [x] Simplified Inventory Orders tab to usage audit with source/date filters and CSV/PDF export.
- [x] Added Inventory Audit Log search/date/actor/action filters and CSV/PDF export.
- [x] Removed global Inventory KPI row; Status tab now owns stock summary cards.
- [x] Removed Missing Recipes/profit/net-income blocks from Reports.
- [x] Added test coverage for physical count CRUD, cost CRUD, and restock no-silent-count behavior.

## Remaining Checklist
- [ ] Recipe backfill preview still uses summary-level existing API; full old/new/delta row preview needs a deeper domain API.
- [x] Recipe backfill reason is collected in UI, passed through preload, persisted in the backfill audit record, and shown in audit text.
- [ ] Restock unlock is recorded as protected access and note text; a first-class `inventory_restock_unlock` audit action can still be added.
- [ ] Physical Count blind staff flow/freshness timer can be made more explicit in the Add Count modal.
- [x] Costs has real system tabs for Raw Materials, Staff Salary, Transport Cost, Staff Food, and Staff Rent when those categories exist; extra categories remain available through a separate selector.
- [x] Reports has been expanded for date-range sales export: source totals, payments, raw-material usage, and cost records are shown and included in PDF output.
- [ ] Expected Left remains hidden in the normal Status table; an admin reveal flow is still pending.

## Verification Plan
- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run build`
- [x] `npm run package`
- [x] `npm run smoke:packaged`

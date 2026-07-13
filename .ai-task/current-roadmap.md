# Yamzo POS release roadmap

## 2026-07-13 final inventory correction pass - complete

- [x] Make **Add Recipe** create a named standalone reusable recipe instead of opening the first incomplete menu recipe.
- [x] Keep recipe editors open across ingredient pickers and searchable dropdown dismissal; normalize modal body/footer sizing.
- [x] Store editable restock/count event timestamps with second precision and preserve the Dhaka local wall-clock value through edits.
- [x] Replay inventory events chronologically and enforce physical counts as reduction-only absolute reconciliations.
- [x] Show timestamped restock/count history and uncapped, date-range-aware reconciliation totals and event details in Reports.
- [x] Package and verify the release with disposable data, 41 tests, native-module smoke, rendered modal/count/report checks, and zero renderer errors.

### Final correction evidence

- Standalone recipe `QA Standalone Sauce` was created in the packaged app with one ingredient, `standalone: true`, and no menu binding.
- A rejected `99999` count left the dialog open with the expected restock guidance; a valid `8000` count stored `reductionDelta: -750`.
- The packaged edit flow preserved `2026-07-13 12:00:45` exactly across reopen and resave in Asia/Dhaka.
- Reports returned 20 restocks, one physical count, 26,250 TK restock spend, and range-specific event details without horizontal overflow.
- Final artifact: `E:\Yamzo\POS\release\win-unpacked\Yamzo POS.exe`, SHA-256 `0FED1E944FB5B820315FFC7D6FC23784328601C30B87118F0F87B0E565A23B74`.
- Git result: no staging, commit, or push; the desktop shortcut preflight remains non-mutating.

## 2026-07-13 second release pass - complete

- [x] Reconcile the unpushed mega-plan worktree, supplied screenshots, component map, and CodeGraph index.
- [x] Replace credential-file Google setup with a locally managed OAuth client, spreadsheet discovery, and explicit sheet-tab mapping.
- [x] Combine Google Sheets and email summaries into one Admin Integrations workspace with a configurable daily send time.
- [x] Move menu-to-inventory bindings into Menu and remove the duplicate Inventory configuration surface.
- [x] Add accessible searchable comboboxes for data-backed dropdowns and repair the nested recipe ingredient workflow.
- [x] Polish Menu, Inventory, and Costs hierarchy, density, states, filters, and editing workflows without changing accounting rules.
- [x] Resolve stored menu-source labels across UI, email, and receipts; harden Electron focus restoration.
- [x] Add a guarded, user-triggered **Push Yamzo Update to GitHub** desktop shortcut without pushing during implementation.
- [x] Verify with 38 tests, disposable seeded data, rendered desktop inspection, production build, Windows package, and packaged smoke test.

### Second-pass release evidence

- Final package: `E:\Yamzo\POS\release\win-unpacked\Yamzo POS.exe`.
- Disposable QA data: 8 menu items, 100 inventory items, 3 recipes, 8 completed orders, 3 open orders, 6 costs, and 1 physical count.
- Packaged checks: immediate typing/focus, blank-safe menu binding, recipe picker persistence and Escape behavior, configured source label, Dhaka business dates, Counts/Costs edit flows, responsive Integrations UI, and zero captured renderer errors.
- Git result: no staging, commit, or push. Shortcut preflight was verified non-mutating and independently audited.

## First release implementation - complete

- [x] Inspect architecture, schema, UI flows, CodeGraph, recipe CSV, live database shape, and Google Sheet access.
- [x] Back up live SQLite databases before schema changes and add automatic pre-migration backups for production upgrades.
- [x] Implement order timer/date/number and reporting corrections.
- [x] Implement versioned recipes, direct inventory bindings, bulk import modes, and historical application scopes.
- [x] Implement configurable one-way Google Sheets reconciliation and bound report tooling.
- [x] Rebuild operator UI for reports, costs, counts, inventory/menu bindings, recipe history, and admin sync.

## External authorization handoff

- The final Admin Integrations screen accepts the OAuth client ID and secret, shows the exact redirect URI, discovers spreadsheets and tabs, maps Orders/Order Items/Costs, and uses the same Google account for Gmail summaries.
- A live OAuth request was intentionally not repeated during the final package pass. The owner must save the client, connect/reconnect once for the expanded Drive/Gmail/Apps Script scopes, select the spreadsheet and tabs, then run Sync Now.
- Google Cloud Apps Script API enablement and the per-user Apps Script dashboard permission are separate; the app provides a direct action for the latter if Google reports it disabled.

## Hard constraints preserved

- SQLite remains the only source of truth; Google Sheets never writes back.
- Google/network failure does not block local order or cost CRUD.
- Existing order IDs and external order IDs stay stable under the specified date-edit rules.
- Secrets and tokens remain local, ignored, absent from renderer responses, and protected by the release shortcut.
- UI remains within the existing shadcn/Radix system and supports keyboard/focus operation.

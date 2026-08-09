# Yamzo POS

Local-first Windows POS for Yamzo restaurant.

## Stack

- Electron
- React
- TypeScript
- Node.js
- SQLite via `better-sqlite3`

## Scripts

```powershell
npm run dev
npm run build
npm run package
npm run dist
npm run test
```

`npm run package` creates an unpacked Windows app. `npm run dist` creates the Windows setup exe.
On this machine, the packaging script automatically falls back to a custom Electron distribution path if Windows blocks electron-builder's rename step.

## Default Login

- Username: `admin`
- Password: `1234`

Change the password from the admin flow before real restaurant use.

## Local Data

The app stores runtime data locally, outside Git:

- SQLite database
- uploaded logo and QR assets
- printer settings
- Gmail OAuth tokens
- Google Sheets OAuth tokens
- local logs

Set `YAMZO_APP_DATA_DIR` to override the local app-data location during testing.

## Current Capabilities

- Local admin login with hashed password storage
- Menu CSV import
- Open/running orders
- Dine-in, takeaway, parcel, delivery, Foodpanda, Foodie, and other sources
- KOT, addition KOT, void KOT, receipt, and reprint print jobs
- Windows printer listing/printing flow through Electron
- Discount and settlement logic
- Editable order business dates with collision-safe internal number regeneration
- Order history and date-filtered operational reports by source, payment, item, cost, and commission
- Receipt branding settings
- Gmail notification settings and daily summary generation
- Recipe versioning with snapshot-on/snapshot-off edits and bulk recipe CSV import
- Direct inventory-item and reusable recipe bindings with future/all/date-range historical recalculation
- Inventory restocks, physical-count CRUD, raw-material usage, and cost/profit tracking
- Cost CRUD and one-way Orders/Order Items/Costs reconciliation to Google Sheets
- Bound Google Apps Script report modal with quick date filters and detailed PDF output

## Google Sheets

Configure Sheets sync, the report tool, and scheduled email under **Admin > Integrations**. The POS database is always the source of truth; spreadsheet edits are never imported into the POS.

- Authorized redirect URI: `http://127.0.0.1:42813/oauth2callback`
- Enter the OAuth client ID and secret in the app. The secret and refresh token stay in the current Windows user's local app data and are never returned to the renderer.
- Connect once, choose a spreadsheet, load and map its tabs, enable automatic sync, then use **Sync now** for an immediate full reconciliation.
- Use **Install report tool** to add the `Yamzo Reports` menu and PDF date-range modal to the bound spreadsheet.
- Daily summary email reuses the same Google connection and runs once per local business date at the configured `HH:mm` time.

Google/network failures are recorded as a pending sync and never block local order or cost CRUD.

## Website Orders Transport

Website-order synchronization runs only in Electron's main process and stays
disabled when no transport configuration is present. Configure these two
non-secret values in the protected Windows launch environment:

- `YAMZO_WEBSITE_API_URL=https://yamzouttara.com`
- `YAMZO_POS_TERMINAL_CODE=YAMZO_UTTARA_01`

Set `YAMZO_POS_INCLUDE_TEST_ORDERS=1` only on a terminal intended to receive
test-mode orders. Cleartext HTTP is rejected except for loopback development.

Provision the terminal key once with the packaged executable while the normal
POS is closed:

```powershell
& '.\Yamzo POS.exe' --provision-website-terminal=YAMZO_UTTARA_01
```

Electron encrypts the Ed25519 private key with Windows DPAPI and writes only a
protected credential under the app's user-data folder. The command prints and
writes public registration material only. Register its `publicKeyBase64Url`
through the permission-gated `api.register_pos_terminal_key` RPC, then start the
POS normally. Supabase stores only the public key and fingerprint.

```sql
select api.register_pos_terminal_key(
  'YAMZO_UTTARA_01',
  'Yamzo Uttara POS',
  '<publicKeyBase64Url from the provisioning result>',
  now() + interval '180 days'
);
```

For planned rotation, close the POS and use
`--rotate-website-terminal=YAMZO_UTTARA_01`. The old DPAPI-protected file is
retained as a recovery copy; register the newly returned public key before
restarting sync. Never paste a private key into Supabase, the website,
renderer/preload, logs, Git, or a repository `.env` file.

### Website menu reconciliation

Website items are mapped by the authoritative public ID **and exact effective
unit price**. There is no name fallback. This supports package variants such as
regular/family/party shingara without applying the wrong inventory recipe.

After importing and reviewing the real active POS menu, build the Electron main
process and run a read-only reconciliation:

```powershell
npm run build:electron
node scripts\reconcile-website-menu.mjs
```

The packaged catalog contract is `resources\website-menu-contract.json`.
Reconciliation must report `canApply: true` for every entry. Then apply it with
an automatic SQLite backup:

```powershell
node scripts\reconcile-website-menu.mjs --apply
```

Until a complete contract is applied, or whenever a mapped POS item is
archived/renamed/repriced, website items remain unmapped and cannot be accepted,
printed, or applied to inventory.

## Database Upgrade Safety

Before a schema upgrade, the app creates a transactionally consistent SQLite backup under the local `backups` folder. It keeps the five newest automatic migration backups and aborts the migration if a recovery copy cannot be created.

## Git Safety

Do not commit:

- SQLite database files
- Google OAuth client-secret and token files
- local printer settings
- uploaded logo/QR assets
- local app-data folders

These are covered by `.gitignore`.

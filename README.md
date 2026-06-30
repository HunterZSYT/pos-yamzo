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
- Order history and sales summary
- Receipt branding settings
- Gmail notification settings and daily summary generation
- Inventory tracking setting reserved for a future update

## Git Safety

Do not commit:

- `yamzo_google_creds.txt`
- SQLite database files
- Gmail credentials or tokens
- local printer settings
- uploaded logo/QR assets
- local app-data folders

These are covered by `.gitignore`.

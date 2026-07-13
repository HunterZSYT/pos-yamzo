# Yamzo POS Installation Guide

## Install on the POS Computer

1. Install Node.js LTS or use the packaged Windows installer once available.
2. Clone or download the Yamzo POS repository.
3. Double-click `START_YAMZO_POS.bat`.

The launcher opens the packaged app if it already exists. If not, it installs npm dependencies, builds the packaged app, and then starts Yamzo POS.

Manual build commands are still available:

```powershell
npm install
npm run build
npm run package
```

The generated installer is written to:

```text
release-packaged\Yamzo POS Setup 0.1.0.exe
```

The unpacked app for quick testing is written to:

```text
release-packaged\win-unpacked\Yamzo POS.exe
```

## First Login

- Username: `admin`
- Password: `1234`

Change the password from the admin area before daily use.

## Import Menu CSV

Use the Admin > Menu Items import action and select the menu CSV from the file picker.

Rows like `Front Page`, `1st Page`, `2nd Page`, `Sauce List`, and empty rows are ignored.

## Printer Setup

Printer target:

- Xprinter XP-80T
- 80mm thermal paper
- ESC/POS capable
- USB/Windows printer flow first

Configure the Windows printer name in admin settings, then use test print before restaurant use.
If a print fails, the print job remains in the queue and can be retried.

## Receipt Branding

In admin settings, configure:

- restaurant name
- address
- phone
- footer message
- VAT/BIN/trade license text
- logo enabled/disabled
- QR enabled/disabled

Uploaded logo and QR files must remain in local app data, not Git.

## Google Sheets, Reports, and Daily Email

1. In Google Cloud, use a Web application OAuth client and add this exact authorized redirect URI:

```text
http://127.0.0.1:42813/oauth2callback
```

2. Open **Admin > Integrations**, enter the OAuth client ID and secret, and save them. The secret is written only to this Windows user's local app-data folder and is never returned to the interface.
3. Choose **Connect Google** and approve the requested Sheets, Drive metadata, Apps Script, Gmail send, and account-email permissions.
4. Choose an available spreadsheet (or enter its URL), load its tabs, and map Orders, Order Items, and Costs.
5. Enable automatic sync and choose **Sync now**. The POS writes the three mapped datasets and never imports Sheet edits.
6. Choose **Install report tool**, reopen the spreadsheet, and use **Yamzo Reports > Download detailed PDF**.
7. In the same Integrations screen, choose the daily-summary recipient and local send time, then send a test email before enabling the schedule.

Google Cloud API enablement and the Google account's Apps Script access setting are separate. If the installer reports that account access is disabled, open `https://script.google.com/home/usersettings`, enable Apps Script API access, wait a few minutes, and retry.

The Google OAuth client secret and refresh token are stored in local app data and must never be committed. Sheets and scheduled Gmail summaries reuse one connection. If the OAuth client changes, save the new client and reconnect from the POS; do not hand-edit local auth files.

## Upgrade Backups

When an existing database needs a newer schema, Yamzo POS creates a consistent pre-migration backup before changing any tables. Backups are stored beside the database under `backups`; the newest five automatic migration backups are retained.

## Local Data Location

By default, Electron stores data under the Windows app user-data folder. For testing, set:

```powershell
$env:YAMZO_APP_DATA_DIR="E:\Yamzo\POS\local-data"
```

## Files Not To Commit

- `*.sqlite`, `*.sqlite3`, `*.db`
- Google OAuth client-secret and token files
- printer config files
- uploaded logos and QR images
- local app-data folders

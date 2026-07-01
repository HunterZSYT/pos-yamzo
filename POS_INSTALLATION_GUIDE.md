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

## Gmail Notifications

Gmail notifications are disabled by default. Store OAuth credentials and tokens locally only. Do not commit credential files or token files.
Use the admin Gmail settings to save local credential/token paths, preview the daily sales email, send a test/daily email, and clear local auth.

## Local Data Location

By default, Electron stores data under the Windows app user-data folder. For testing, set:

```powershell
$env:YAMZO_APP_DATA_DIR="E:\Yamzo\POS\local-data"
```

## Files Not To Commit

- `yamzo_google_creds.txt`
- `*.sqlite`, `*.sqlite3`, `*.db`
- Gmail credential/token files
- printer config files
- uploaded logos and QR images
- local app-data folders

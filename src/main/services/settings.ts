import type Database from "better-sqlite3";
import type { BrandingSettings } from "../../shared/types.js";

const DEFAULT_LOGO_PATH = "yamzo://default-logo";
const DEFAULT_QR_PATH = "yamzo://review-qr";
const DEFAULT_HOST_NAMES = ["Cashier"];
const DEFAULT_MENU_CATEGORIES = ["Seafood", "Momo", "Fish & Chips", "Pasta", "Rice", "Soup", "Snacks", "Sauce", "Drinks", "Other"];

export function getSetting<T>(db: Database.Database, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) {
    return fallback;
  }
  return JSON.parse(row.value) as T;
}

export function setSetting(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, JSON.stringify(value));
}

export function getBrandingSettings(db: Database.Database): BrandingSettings {
  return { ...defaultBrandingSettings(), ...getSetting<BrandingSettings>(db, "branding", defaultBrandingSettings()) };
}

export function defaultBrandingSettings(): BrandingSettings {
  return {
    restaurantName: "Yamzo",
    address: "House-80, Road-20, Sector 11, Uttara, Dhaka 1230",
    phone: "01761-737584",
    emailWebsiteSocial: "yamzo.uttara@gmail.com",
    footerMessage: "THANK YOU FOR DINING WITH US!",
    vatText: "",
    showLogo: true,
    showQr: true,
    showAddressPhone: true,
    showFooter: true,
    logoPath: DEFAULT_LOGO_PATH,
    qrPath: DEFAULT_QR_PATH
  };
}

export function setBrandingSettings(db: Database.Database, branding: BrandingSettings): void {
  setSetting(db, "branding", branding);
}

export function setInventoryTracking(db: Database.Database, enabled: boolean): void {
  setSetting(db, "trackInventory", enabled);
}

export function getInventoryTracking(db: Database.Database): boolean {
  return getSetting<boolean>(db, "trackInventory", false);
}

export function getPrinterName(db: Database.Database): string {
  return getSetting<string>(db, "printerName", "");
}

export function setPrinterName(db: Database.Database, printerName: string): void {
  setSetting(db, "printerName", printerName.trim());
}

export function getTotalTables(db: Database.Database): number {
  const value = getSetting<number>(db, "totalTables", 10);
  return Number.isInteger(value) && value > 0 ? value : 10;
}

export function setTotalTables(db: Database.Database, totalTables: number): void {
  if (!Number.isInteger(totalTables) || totalTables < 1 || totalTables > 200) {
    throw new Error("Total tables must be between 1 and 200.");
  }
  setSetting(db, "totalTables", totalTables);
}

export function getHostNames(db: Database.Database): string[] {
  const hosts = getSetting<string[]>(db, "hostNames", DEFAULT_HOST_NAMES);
  const cleaned = hosts.map((host) => host.trim()).filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)) : DEFAULT_HOST_NAMES;
}

export function setHostNames(db: Database.Database, hostNames: string[]): void {
  const cleaned = Array.from(new Set(hostNames.map((host) => host.trim()).filter(Boolean)));
  setSetting(db, "hostNames", cleaned.length ? cleaned : DEFAULT_HOST_NAMES);
}

export function getMenuCategories(db: Database.Database): string[] {
  const saved = getSetting<string[]>(db, "menuCategories", DEFAULT_MENU_CATEGORIES);
  const fromMenu = db.prepare("SELECT DISTINCT category FROM menu_items WHERE archived = 0 AND category IS NOT NULL AND trim(category) <> '' ORDER BY category").all() as Array<{ category: string }>;
  const merged = [...saved, ...fromMenu.map((row) => row.category)];
  const cleaned = Array.from(new Set(merged.map((category) => category.trim()).filter(Boolean)));
  return cleaned.length ? cleaned : DEFAULT_MENU_CATEGORIES;
}

export function setMenuCategories(db: Database.Database, categories: string[]): void {
  const cleaned = Array.from(new Set(categories.map((category) => category.trim()).filter(Boolean)));
  setSetting(db, "menuCategories", cleaned.length ? cleaned : DEFAULT_MENU_CATEGORIES);
}

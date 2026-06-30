import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const BRANDING_DEFAULTS_VERSION = 2;

const defaultBranding = {
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
  logoPath: "yamzo://default-logo",
  qrPath: "yamzo://review-qr"
};

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      price INTEGER NOT NULL,
      category TEXT,
      available INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      table_number TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      discount INTEGER NOT NULL DEFAULT 0,
      first_kitchen_sent_at TEXT,
      kitchen_completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      note TEXT,
      parcel INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      kitchen_sent_at TEXT,
      void_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kitchen_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      type TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kitchen_ticket_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES kitchen_tickets(id) ON DELETE CASCADE,
      order_item_id INTEGER NOT NULL REFERENCES order_items(id),
      quantity INTEGER NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      method TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS print_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      printer TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      printed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS branding_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      recipient_email TEXT,
      send_daily_summary INTEGER NOT NULL DEFAULT 0,
      send_each_settled_order INTEGER NOT NULL DEFAULT 0,
      credential_path TEXT,
      token_path TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      short_name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category_id INTEGER REFERENCES inventory_categories(id),
      base_unit_id INTEGER NOT NULL REFERENCES inventory_units(id),
      low_stock_threshold REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_restock_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity_base REAL NOT NULL,
      unit_label TEXT NOT NULL,
      total_cost REAL NOT NULL DEFAULT 0,
      price_per_base REAL NOT NULL DEFAULT 0,
      supplier_name TEXT,
      responsible_person TEXT,
      note TEXT,
      entry_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      price_per_base REAL NOT NULL,
      effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responsible_person TEXT,
      note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS menu_item_recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL UNIQUE REFERENCES menu_items(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES menu_item_recipes(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity_base REAL NOT NULL,
      unit_label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(recipe_id, inventory_item_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity_delta REAL NOT NULL,
      reason TEXT NOT NULL,
      order_id INTEGER REFERENCES orders(id),
      order_item_id INTEGER REFERENCES order_items(id),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cost_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cost_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cost_category_id INTEGER REFERENCES cost_categories(id),
      cost_name TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT,
      responsible_person TEXT,
      note TEXT,
      cost_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_item_cost_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      order_item_id INTEGER NOT NULL UNIQUE REFERENCES order_items(id),
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
      quantity INTEGER NOT NULL,
      revenue REAL NOT NULL,
      raw_cost REAL NOT NULL,
      profit REAL NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_cost_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      revenue REAL NOT NULL,
      raw_cost REAL NOT NULL,
      other_cost REAL NOT NULL DEFAULT 0,
      gross_profit REAL NOT NULL,
      net_profit REAL NOT NULL,
      missing_recipe_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_restock_item_date ON inventory_restock_entries(inventory_item_id, entry_date);
    CREATE INDEX IF NOT EXISTS idx_inventory_price_item_date ON inventory_price_history(inventory_item_id, effective_at);
    CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_item_date ON inventory_adjustments(inventory_item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_order ON inventory_adjustments(order_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_date ON cost_records(cost_date);
    CREATE INDEX IF NOT EXISTS idx_order_cost_snapshots_order ON order_cost_snapshots(order_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
  `);

  ensureColumn(db, "order_items", "parcel", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "first_kitchen_sent_at", "TEXT");
  ensureColumn(db, "orders", "kitchen_completed_at", "TEXT");
  ensureColumn(db, "kitchen_tickets", "completed_at", "TEXT");

  seedDefaults(db);
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

function seedDefaults(db: Database.Database): void {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (userCount.count === 0) {
    const hash = bcrypt.hashSync("1234", 12);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run("admin", hash, "admin");
  }

  const defaults: Record<string, unknown> = {
    trackInventory: false,
    totalTables: 10,
    printerName: "",
    hostNames: ["Cashier"],
    branding: defaultBranding
  };

  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, JSON.stringify(value));
  }

  applyOneTimeBrandingDefaults(db);

  db.prepare("INSERT OR IGNORE INTO email_settings (id) VALUES (1)").run();

  seedInventoryDefaults(db);
}

function seedInventoryDefaults(db: Database.Database): void {
  const units = [
    ["Gram", "g"],
    ["Kilogram", "kg"],
    ["Milliliter", "ml"],
    ["Liter", "l"],
    ["Piece", "pc"],
    ["Packet", "packet"],
    ["Portion", "portion"],
    ["Teaspoon", "tsp"],
    ["Tablespoon", "tbsp"]
  ];
  const unitInsert = db.prepare("INSERT OR IGNORE INTO inventory_units (name, short_name) VALUES (?, ?)");
  for (const [name, shortName] of units) {
    unitInsert.run(name, shortName);
  }

  const inventoryCategories = ["Seafood", "Meat", "Vegetable", "Spice", "Sauce", "Dairy", "Dry Goods", "Packaging", "Other"];
  const categoryInsert = db.prepare("INSERT OR IGNORE INTO inventory_categories (name) VALUES (?)");
  for (const name of inventoryCategories) {
    categoryInsert.run(name);
  }

  const costCategories = ["Staff Salary", "Electricity", "Gas", "Water", "Rent", "Maintenance", "Packaging", "Delivery Expense", "Cleaning", "Other"];
  const costInsert = db.prepare("INSERT OR IGNORE INTO cost_categories (name) VALUES (?)");
  for (const name of costCategories) {
    costInsert.run(name);
  }

  db.prepare("INSERT OR IGNORE INTO inventory_settings (key, value) VALUES ('lowStockDefault', ?)").run(JSON.stringify(1000));
}

function applyOneTimeBrandingDefaults(db: Database.Database): void {
  const versionRow = db.prepare("SELECT value FROM settings WHERE key = 'brandingDefaultsVersion'").get() as { value: string } | undefined;
  const version = versionRow ? Number(JSON.parse(versionRow.value)) : 0;
  if (version >= BRANDING_DEFAULTS_VERSION) {
    return;
  }
  const brandingRow = db.prepare("SELECT value FROM settings WHERE key = 'branding'").get() as { value: string } | undefined;
  const current = brandingRow ? JSON.parse(brandingRow.value) as Record<string, unknown> : {};
  const next = {
    ...defaultBranding,
    ...current,
    phone: typeof current.phone === "string" && current.phone.trim() && current.phone !== "01316-737584" ? current.phone : defaultBranding.phone,
    emailWebsiteSocial: typeof current.emailWebsiteSocial === "string" && current.emailWebsiteSocial.trim() ? current.emailWebsiteSocial : defaultBranding.emailWebsiteSocial,
    showLogo: true,
    showQr: true,
    logoPath: typeof current.logoPath === "string" && current.logoPath.trim() ? current.logoPath : defaultBranding.logoPath,
    qrPath: typeof current.qrPath === "string" && current.qrPath.trim() ? current.qrPath : defaultBranding.qrPath
  };
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run("branding", JSON.stringify(next));
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('brandingDefaultsVersion', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(JSON.stringify(BRANDING_DEFAULTS_VERSION));
}

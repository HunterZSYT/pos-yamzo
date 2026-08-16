import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const BRANDING_DEFAULTS_VERSION = 2;
export const DATABASE_SCHEMA_VERSION = 9;

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

    CREATE TABLE IF NOT EXISTS managers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manager_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      price INTEGER NOT NULL,
      category TEXT,
      track_recipe INTEGER NOT NULL DEFAULT 1,
      available INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS menu_item_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      menu_type_key TEXT NOT NULL,
      price INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(menu_item_id, menu_type_key)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      order_date TEXT,
      source TEXT NOT NULL,
      table_number TEXT,
      guest_count INTEGER NOT NULL DEFAULT 1,
      host_name TEXT NOT NULL DEFAULT 'Cashier',
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

    CREATE TABLE IF NOT EXISTS order_payment_sessions (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      payable_amount INTEGER NOT NULL CHECK(payable_amount >= 0),
      cash_received INTEGER,
      change_given INTEGER NOT NULL DEFAULT 0 CHECK(change_given >= 0),
      reference TEXT,
      host_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    CREATE TABLE IF NOT EXISTS print_job_context (
      print_job_id INTEGER PRIMARY KEY REFERENCES print_jobs(id) ON DELETE RESTRICT,
      order_id INTEGER REFERENCES orders(id) ON DELETE RESTRICT,
      operator TEXT,
      manager_id INTEGER REFERENCES managers(id) ON DELETE RESTRICT,
      reason TEXT,
      related_print_job_id INTEGER REFERENCES print_jobs(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS print_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      print_job_id INTEGER NOT NULL REFERENCES print_jobs(id) ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      success INTEGER,
      error_message TEXT,
      UNIQUE(print_job_id, attempt_number)
    );

    CREATE INDEX IF NOT EXISTS idx_print_attempts_job
      ON print_attempts(print_job_id, requested_at);

    CREATE TABLE IF NOT EXISTS order_print_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      print_job_id INTEGER NOT NULL UNIQUE REFERENCES print_jobs(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN ('initial_kot', 'addition_kot', 'swap_change', 'void_kot')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS order_print_requirements_order
      ON order_print_requirements(order_id, created_at);

    CREATE TABLE IF NOT EXISTS order_bill_prints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      print_job_id INTEGER NOT NULL UNIQUE REFERENCES print_jobs(id) ON DELETE RESTRICT,
      is_original INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS order_bill_prints_order
      ON order_bill_prints(order_id, created_at);

    CREATE TABLE IF NOT EXISTS swap_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      original_order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
      replacement_order_item_id INTEGER REFERENCES order_items(id) ON DELETE RESTRICT,
      original_name TEXT NOT NULL,
      original_quantity INTEGER NOT NULL,
      replacement_name TEXT,
      replacement_quantity INTEGER,
      manager_id INTEGER NOT NULL REFERENCES managers(id) ON DELETE RESTRICT,
      manager_name TEXT NOT NULL,
      operator TEXT NOT NULL,
      reason TEXT NOT NULL,
      original_kot_print_job_id INTEGER REFERENCES print_jobs(id) ON DELETE RESTRICT,
      adjustment_print_job_id INTEGER NOT NULL UNIQUE REFERENCES print_jobs(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_swap_events_order_created
      ON swap_events(order_id, created_at);

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
      send_time TEXT NOT NULL DEFAULT '22:00',
      last_daily_summary_date TEXT,
      last_daily_summary_sent_at TEXT,
      last_error TEXT,
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
      item_type TEXT NOT NULL DEFAULT 'raw',
      recipe_id INTEGER REFERENCES menu_item_recipes(id),
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

    CREATE TABLE IF NOT EXISTS inventory_physical_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity_base REAL NOT NULL,
      unit_label TEXT NOT NULL,
      responsible_person TEXT,
      note TEXT,
      count_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source TEXT NOT NULL DEFAULT 'manual',
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
      restock_enabled INTEGER NOT NULL DEFAULT 0,
      current_version_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recipe_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES menu_item_recipes(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      change_note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(recipe_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS recipe_version_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity_base REAL NOT NULL,
      reduction_delta REAL,
      unit_label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(version_id, inventory_item_id)
    );

    CREATE TABLE IF NOT EXISTS recipe_version_child_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
      child_recipe_id INTEGER NOT NULL REFERENCES menu_item_recipes(id),
      child_version_id INTEGER REFERENCES recipe_versions(id),
      quantity_base REAL NOT NULL,
      unit_label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(version_id, child_recipe_id)
    );

    CREATE TABLE IF NOT EXISTS menu_item_inventory_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL UNIQUE REFERENCES menu_items(id) ON DELETE CASCADE,
      binding_type TEXT NOT NULL CHECK(binding_type IN ('recipe', 'item')),
      recipe_id INTEGER REFERENCES menu_item_recipes(id),
      inventory_item_id INTEGER REFERENCES inventory_items(id),
      quantity_base REAL NOT NULL DEFAULT 1,
      unit_label TEXT NOT NULL DEFAULT 'portion',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(
        (binding_type = 'recipe' AND recipe_id IS NOT NULL AND inventory_item_id IS NULL) OR
        (binding_type = 'item' AND inventory_item_id IS NOT NULL AND recipe_id IS NULL)
      )
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

    CREATE TABLE IF NOT EXISTS recipe_child_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES menu_item_recipes(id) ON DELETE CASCADE,
      child_recipe_id INTEGER NOT NULL REFERENCES menu_item_recipes(id) ON DELETE CASCADE,
      quantity_base REAL NOT NULL,
      unit_label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(recipe_id, child_recipe_id)
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
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cost_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cost_category_id INTEGER REFERENCES cost_categories(id),
      cost_name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
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
    CREATE INDEX IF NOT EXISTS idx_menu_item_prices_item_type ON menu_item_prices(menu_item_id, menu_type_key);
    CREATE INDEX IF NOT EXISTS idx_inventory_restock_item_date ON inventory_restock_entries(inventory_item_id, entry_date);
    CREATE INDEX IF NOT EXISTS idx_inventory_physical_counts_item_date ON inventory_physical_counts(inventory_item_id, count_date);
    CREATE INDEX IF NOT EXISTS idx_inventory_price_item_date ON inventory_price_history(inventory_item_id, effective_at);
    CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_child_ingredients_recipe ON recipe_child_ingredients(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_versions_recipe ON recipe_versions(recipe_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_recipe_version_ingredients_version ON recipe_version_ingredients(version_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_version_child_version ON recipe_version_child_ingredients(version_id);
    CREATE INDEX IF NOT EXISTS idx_menu_inventory_binding_recipe ON menu_item_inventory_bindings(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_menu_inventory_binding_item ON menu_item_inventory_bindings(inventory_item_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_item_date ON inventory_adjustments(inventory_item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_order ON inventory_adjustments(order_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_date ON cost_records(cost_date);
    CREATE INDEX IF NOT EXISTS idx_order_cost_snapshots_order ON order_cost_snapshots(order_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
  `);

  ensureColumn(db, "order_items", "parcel", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "order_date", "TEXT");
  ensureColumn(db, "orders", "external_order_id", "TEXT");
  ensureColumn(db, "orders", "first_kitchen_sent_at", "TEXT");
  ensureColumn(db, "orders", "kitchen_completed_at", "TEXT");
  ensureColumn(db, "kitchen_tickets", "completed_at", "TEXT");
  ensureColumn(db, "inventory_restock_entries", "updated_at", "TEXT");
  ensureColumn(db, "inventory_restock_entries", "item_type", "TEXT NOT NULL DEFAULT 'raw'");
  ensureColumn(db, "inventory_restock_entries", "recipe_id", "INTEGER");
  ensureColumn(db, "inventory_restock_entries", "entry_type", "TEXT NOT NULL DEFAULT 'purchase'");
  ensureColumn(db, "inventory_restock_entries", "adjustment_reason", "TEXT");
  ensureColumn(db, "inventory_adjustments", "restock_entry_id", "INTEGER");
  ensureColumn(db, "menu_item_recipes", "restock_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "menu_item_recipes", "use_in_recipe_enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "menu_item_recipes", "current_version_id", "INTEGER");
  ensureColumn(db, "menu_items", "track_recipe", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "menu_items", "public_id", "TEXT");
  ensureColumn(db, "orders", "is_test", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "delivery_fee", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "guest_count", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "orders", "host_name", "TEXT NOT NULL DEFAULT 'Cashier'");
  ensureColumn(db, "orders", "initial_kot_print_job_id", "INTEGER");
  ensureColumn(db, "orders", "initial_kot_printed_at", "TEXT");
  ensureColumn(db, "orders", "bill_print_job_id", "INTEGER");
  ensureColumn(db, "orders", "paid_slip_print_job_id", "INTEGER");
  ensureColumn(db, "orders", "requires_kot", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "swap_events", "event_kind", "TEXT NOT NULL DEFAULT 'swap'");
  db.prepare(
    "UPDATE swap_events SET event_kind = 'cancel' WHERE replacement_order_item_id IS NULL"
  ).run();
  db.prepare(
    "UPDATE orders SET requires_kot = 1 WHERE status IN ('open', 'kitchen_sent')"
  ).run();
  db.prepare(
    `UPDATE orders
     SET initial_kot_printed_at = first_kitchen_sent_at
     WHERE initial_kot_print_job_id IS NULL
       AND initial_kot_printed_at IS NULL
       AND first_kitchen_sent_at IS NOT NULL`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO order_print_requirements (order_id, print_job_id, kind)
     SELECT id, initial_kot_print_job_id, 'initial_kot'
     FROM orders
     WHERE requires_kot = 1 AND initial_kot_print_job_id IS NOT NULL`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO order_bill_prints (order_id, print_job_id, is_original)
     SELECT id, bill_print_job_id, 1
     FROM orders
     WHERE bill_print_job_id IS NOT NULL`
  ).run();
  ensureColumn(db, "inventory_physical_counts", "updated_at", "TEXT");
  ensureColumn(db, "inventory_physical_counts", "reduction_delta", "REAL");
  ensureColumn(db, "cost_records", "quantity", "REAL NOT NULL DEFAULT 1");
  ensureColumn(db, "cost_categories", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "order_item_cost_snapshots", "recipe_version_id", "INTEGER");
  ensureColumn(db, "order_item_cost_snapshots", "binding_type", "TEXT");
  ensureColumn(db, "order_item_cost_snapshots", "binding_id", "INTEGER");
  ensureColumn(db, "email_settings", "send_time", "TEXT NOT NULL DEFAULT '22:00'");
  ensureColumn(db, "email_settings", "last_daily_summary_date", "TEXT");
  ensureColumn(db, "email_settings", "last_daily_summary_sent_at", "TEXT");
  ensureColumn(db, "email_settings", "last_error", "TEXT");

  migrateWebsiteOrders(db);

  // This index must be created after the legacy orders table has been upgraded
  // because older databases do not have order_date when the main schema batch runs.
  db.exec("CREATE INDEX IF NOT EXISTS idx_orders_date_status ON orders(order_date, status)");

  migrateOrderDates(db);
  migrateInventoryEventTimeline(db);
  migrateRecipeVersionsAndBindings(db);
  migrateOrderDeletionProtection(db);

  seedDefaults(db);
  db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
}

function migrateInventoryEventTimeline(db: Database.Database): void {
  db.prepare(
    `UPDATE inventory_restock_entries
     SET entry_date = entry_date || ' 00:00:00'
     WHERE length(trim(entry_date)) = 10 AND date(entry_date) IS NOT NULL`
  ).run();
  db.prepare(
    `UPDATE inventory_physical_counts
     SET count_date = count_date || ' 00:00:00'
     WHERE length(trim(count_date)) = 10 AND date(count_date) IS NOT NULL`
  ).run();
  db.prepare(
    `UPDATE inventory_adjustments
     SET created_at = COALESCE(
       (SELECT COALESCE(o.settled_at, o.updated_at, o.created_at) FROM orders o WHERE o.id = inventory_adjustments.order_id),
       created_at
     )
     WHERE reason = 'Order usage' AND order_id IS NOT NULL`
  ).run();
}

function migrateOrderDates(db: Database.Database): void {
  db.prepare(
    `UPDATE orders
     SET order_date = date(created_at, 'localtime')
     WHERE order_date IS NULL OR trim(order_date) = ''`
  ).run();
}

function migrateOrderDeletionProtection(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_orders_prevent_delete
    BEFORE DELETE ON orders
    BEGIN
      SELECT RAISE(ABORT, 'Orders cannot be deleted. Cancel the order instead.');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_website_orders_prevent_delete
    BEFORE DELETE ON website_orders
    BEGIN
      SELECT RAISE(ABORT, 'Orders cannot be deleted. Cancel the order instead.');
    END;
  `);
}

function migrateWebsiteOrders(db: Database.Database): void {
  db.prepare(
    "UPDATE menu_items SET public_id = 'pos-menu-' || id WHERE public_id IS NULL OR trim(public_id) = ''"
  ).run();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_public_id ON menu_items(public_id);

    CREATE TRIGGER IF NOT EXISTS trg_menu_items_public_id
    AFTER INSERT ON menu_items
    WHEN NEW.public_id IS NULL OR trim(NEW.public_id) = ''
    BEGIN
      UPDATE menu_items SET public_id = 'pos-menu-' || NEW.id WHERE id = NEW.id;
    END;

    CREATE TABLE IF NOT EXISTS website_orders (
      remote_id TEXT PRIMARY KEY,
      order_code TEXT NOT NULL,
      remote_version INTEGER NOT NULL DEFAULT 1 CHECK(remote_version >= 1),
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'rejected', 'cancelled')),
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      sector TEXT NOT NULL,
      road TEXT NOT NULL,
      house TEXT NOT NULL,
      flat TEXT NOT NULL,
      delivery_note TEXT,
      subtotal INTEGER NOT NULL CHECK(subtotal >= 0),
      delivery_fee INTEGER NOT NULL DEFAULT 0 CHECK(delivery_fee >= 0),
      discount INTEGER NOT NULL DEFAULT 0 CHECK(discount >= 0),
      total INTEGER NOT NULL CHECK(total >= 0),
      is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0, 1)),
      pos_order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
      kitchen_print_job_id INTEGER REFERENCES print_jobs(id) ON DELETE SET NULL,
      delivery_print_job_id INTEGER REFERENCES print_jobs(id) ON DELETE SET NULL,
      rejection_reason TEXT,
      remote_created_at TEXT NOT NULL,
      remote_updated_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      accepted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS website_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_order_id TEXT NOT NULL REFERENCES website_orders(remote_id) ON DELETE CASCADE,
      remote_item_id TEXT NOT NULL,
      menu_item_public_id TEXT NOT NULL,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
      note TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(website_order_id, remote_item_id)
    );

    -- Exactly-once local identity for the automatic first Kitchen KOT created
    -- after a website order is claimed and imported into the normal order flow.
    CREATE TABLE IF NOT EXISTS website_initial_kots (
      website_order_id TEXT PRIMARY KEY REFERENCES website_orders(remote_id) ON DELETE CASCADE,
      pos_order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      print_job_id INTEGER NOT NULL UNIQUE REFERENCES print_jobs(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK(state IN ('queued', 'printing', 'awaiting_retry', 'confirmed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      claimed_at TEXT,
      confirmed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS website_initial_kots_state
      ON website_initial_kots (state, updated_at);

    -- A terminal-only print ledger. It lets the POS acknowledge every printed
    -- copy without becoming a source of truth for an order's status or items.
    CREATE TABLE IF NOT EXISTS website_order_prints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_order_id TEXT NOT NULL REFERENCES website_orders(remote_id) ON DELETE CASCADE,
      print_job_id INTEGER NOT NULL UNIQUE REFERENCES print_jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('kitchen_copy', 'customer_receipt')),
      remote_version INTEGER NOT NULL CHECK(remote_version >= 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS website_sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      remote_order_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS website_sync_cursors (
      stream TEXT PRIMARY KEY,
      cursor TEXT,
      last_synced_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS website_menu_contract_state (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      catalog_digest TEXT NOT NULL CHECK(length(catalog_digest) = 64),
      entry_count INTEGER NOT NULL CHECK(entry_count > 0),
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS website_menu_mappings (
      website_public_id TEXT NOT NULL,
      effective_unit_price INTEGER NOT NULL CHECK(effective_unit_price >= 0),
      menu_item_id INTEGER NOT NULL UNIQUE REFERENCES menu_items(id) ON DELETE RESTRICT,
      catalog_digest TEXT NOT NULL CHECK(length(catalog_digest) = 64),
      expected_pos_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(website_public_id, effective_unit_price)
    );

    CREATE INDEX IF NOT EXISTS idx_website_orders_status_received
      ON website_orders(status, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_website_order_items_order
      ON website_order_items(website_order_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_website_order_prints_order
      ON website_order_prints(website_order_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_website_outbox_delivery
      ON website_sync_outbox(status, available_at, id);
    CREATE INDEX IF NOT EXISTS idx_orders_test_status
      ON orders(is_test, status, order_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_website_remote_id
      ON orders(external_order_id)
      WHERE source = 'website' AND external_order_id IS NOT NULL;
  `);

  ensureColumn(db, "website_sync_outbox", "event_key", "TEXT");
  const rowsWithoutEventKeys = db.prepare(
    "SELECT id FROM website_sync_outbox WHERE event_key IS NULL OR trim(event_key) = '' ORDER BY id"
  ).all() as Array<{ id: number }>;
  const assignEventKey = db.prepare(
    "UPDATE website_sync_outbox SET event_key = ? WHERE id = ? AND (event_key IS NULL OR trim(event_key) = '')"
  );
  for (const row of rowsWithoutEventKeys) {
    assignEventKey.run(randomUUID(), row.id);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_website_outbox_event_key ON website_sync_outbox(event_key)");
}

function migrateRecipeVersionsAndBindings(db: Database.Database): void {
  const tx = db.transaction(() => {
    const recipes = db.prepare(
      `SELECT mr.id, mr.menu_item_id, mr.active, mr.current_version_id,
              mi.archived AS menu_item_archived, mi.available AS menu_item_available,
              mi.category AS menu_item_category
       FROM menu_item_recipes mr
       JOIN menu_items mi ON mi.id = mr.menu_item_id
       ORDER BY mr.id`
    ).all() as Array<{
      id: number;
      menu_item_id: number;
      active: number;
      current_version_id: number | null;
      menu_item_archived: number;
      menu_item_available: number;
      menu_item_category: string;
    }>;

    for (const recipe of recipes) {
      let versionId = recipe.current_version_id;
      if (!versionId) {
        const latest = db.prepare("SELECT id FROM recipe_versions WHERE recipe_id = ? ORDER BY version_number DESC LIMIT 1").get(recipe.id) as { id: number } | undefined;
        versionId = latest?.id ?? Number(
          db.prepare("INSERT INTO recipe_versions (recipe_id, version_number, change_note, source) VALUES (?, 1, 'Migrated current recipe', 'migration')").run(recipe.id).lastInsertRowid
        );
        db.prepare("UPDATE menu_item_recipes SET current_version_id = ? WHERE id = ?").run(versionId, recipe.id);
      }
    }

    for (const recipe of recipes) {
      const current = db.prepare("SELECT current_version_id FROM menu_item_recipes WHERE id = ?").get(recipe.id) as { current_version_id: number | null };
      if (!current.current_version_id) continue;
      const rawCount = db.prepare("SELECT COUNT(*) AS count FROM recipe_version_ingredients WHERE version_id = ?").get(current.current_version_id) as { count: number };
      if (rawCount.count === 0) {
        db.prepare(
          `INSERT OR IGNORE INTO recipe_version_ingredients (version_id, inventory_item_id, quantity_base, unit_label)
           SELECT ?, inventory_item_id, quantity_base, unit_label
           FROM recipe_ingredients WHERE recipe_id = ?`
        ).run(current.current_version_id, recipe.id);
      }
      const childCount = db.prepare("SELECT COUNT(*) AS count FROM recipe_version_child_ingredients WHERE version_id = ?").get(current.current_version_id) as { count: number };
      if (childCount.count === 0) {
        db.prepare(
          `INSERT OR IGNORE INTO recipe_version_child_ingredients
           (version_id, child_recipe_id, child_version_id, quantity_base, unit_label)
           SELECT ?, rci.child_recipe_id, child.current_version_id, rci.quantity_base, rci.unit_label
           FROM recipe_child_ingredients rci
           JOIN menu_item_recipes child ON child.id = rci.child_recipe_id
           WHERE rci.recipe_id = ?`
        ).run(current.current_version_id, recipe.id);
      }
      const isStandaloneHolder = recipe.menu_item_archived === 1
        && recipe.menu_item_available === 0
        && recipe.menu_item_category.trim().toLowerCase() === "recipe material";
      if (isStandaloneHolder) {
        db.prepare("DELETE FROM menu_item_inventory_bindings WHERE menu_item_id = ?").run(recipe.menu_item_id);
        continue;
      }
      if (recipe.active === 1) {
        db.prepare(
          `INSERT OR IGNORE INTO menu_item_inventory_bindings
           (menu_item_id, binding_type, recipe_id, inventory_item_id, quantity_base, unit_label)
           VALUES (?, 'recipe', ?, NULL, 1, 'portion')`
        ).run(recipe.menu_item_id, recipe.id);
      }
    }
  });
  tx();
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

  const managerCount = db.prepare("SELECT COUNT(*) AS count FROM managers").get() as { count: number };
  if (managerCount.count === 0) {
    const pinHash = bcrypt.hashSync("1234", 12);
    db.prepare(
      "INSERT INTO managers (manager_code, name, pin_hash, active) VALUES (?, ?, ?, 1)"
    ).run("MGR-001", "Default Manager", pinHash);
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
    ["Piece", "pc"]
  ];
  const unitInsert = db.prepare("INSERT OR IGNORE INTO inventory_units (name, short_name) VALUES (?, ?)");
  for (const [name, shortName] of units) {
    unitInsert.run(name, shortName);
  }
  db.prepare("UPDATE inventory_units SET active = 0 WHERE short_name NOT IN ('g', 'kg', 'ml', 'l', 'pc')").run();

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

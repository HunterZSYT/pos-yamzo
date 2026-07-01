import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.homedir(), "AppData", "Roaming", "yamzo-pos", "local-data", "yamzo-pos.sqlite3");

if (!fs.existsSync(dbPath)) {
  console.log(`[cleanup] Runtime database not found: ${dbPath}`);
  process.exit(0);
}

const db = new Database(dbPath);
try {
  db.pragma("foreign_keys = ON");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM kitchen_ticket_items").run();
    db.prepare("DELETE FROM kitchen_tickets").run();
    db.prepare("DELETE FROM payments").run();
    db.prepare("DELETE FROM inventory_adjustments WHERE order_id IS NOT NULL OR order_item_id IS NOT NULL").run();
    db.prepare("DELETE FROM order_item_cost_snapshots").run();
    db.prepare("DELETE FROM order_cost_snapshots").run();
    db.prepare("DELETE FROM order_items").run();
    db.prepare("DELETE FROM orders").run();
    db.prepare("DELETE FROM print_jobs").run();
    db.prepare("DELETE FROM audit_logs WHERE entity_type IN ('order', 'orders') OR action IN ('delete_order', 'clear_order_history')").run();
  });
  tx();
  console.log("[cleanup] Cleared runtime orders and print queue. Menu items were kept.");
} finally {
  db.close();
}

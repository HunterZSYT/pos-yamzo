import type Database from "better-sqlite3";
import type { ActivityLog } from "../../shared/types.js";

type AuditDetails = Record<string, unknown>;

export function recordActivity(db: Database.Database, action: string, details: AuditDetails = {}, actor = "admin"): void {
  db.prepare("INSERT INTO audit_logs (actor, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)").run(
    actor,
    action,
    typeof details.entityType === "string" ? details.entityType : null,
    typeof details.entityId === "string" ? details.entityId : null,
    JSON.stringify(details)
  );
}

export function recordProtectedPanelAccess(
  db: Database.Database,
  input: { panel: string; success: boolean; method: "password" | "master_key" | "recent_access"; actor?: string }
): void {
  recordActivity(
    db,
    input.success ? "protected_panel_access" : "protected_panel_access_failed",
    {
      panel: input.panel,
      result: input.success ? "success" : "failed",
      method: input.method
    },
    input.actor ?? "admin"
  );
}

export function listActivityLogs(db: Database.Database, limit = 200): ActivityLog[] {
  const rows = db
    .prepare("SELECT id, actor, action, details, created_at FROM audit_logs ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, Math.round(limit)))) as Array<{
    id: number;
    actor: string | null;
    action: string;
    details: string | null;
    created_at: string;
  }>;

  return rows.map((row) => {
    const details = parseDetails(row.details);
    const mapped = describeActivity(row.action, details);
    return {
      id: row.id,
      actor: row.actor,
      action: row.action,
      title: mapped.title,
      description: mapped.description,
      status: mapped.status,
      createdAt: row.created_at
    };
  });
}

function parseDetails(value: string | null): AuditDetails {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as AuditDetails : {};
  } catch {
    return {};
  }
}

function describeActivity(action: string, details: AuditDetails): Pick<ActivityLog, "title" | "description" | "status"> {
  if (action === "protected_panel_access" || action === "protected_panel_access_failed") {
    const panel = friendlyPanel(typeof details.panel === "string" ? details.panel : "protected area");
    const method = details.method === "master_key" ? "master key" : details.method === "recent_access" ? "recent password session" : "admin password";
    const success = action === "protected_panel_access";
    return {
      title: success ? `${panel} opened` : `${panel} access denied`,
      description: success ? `Opened with ${method}.` : `Incorrect password attempt for ${panel}.`,
      status: success ? "success" : "failed"
    };
  }
  if (action === "delete_order") {
    return { title: "Order cancelled or deleted", description: reasonText(details), status: "info" };
  }
  if (action === "reopen_order") {
    return { title: "Order reopened", description: "A closed order was reopened for correction.", status: "info" };
  }
  if (action === "clear_order_history") {
    const count = typeof details.deletedOrders === "number" ? details.deletedOrders : 0;
    return { title: "Order history cleared", description: `${count} closed order${count === 1 ? "" : "s"} removed from local history.`, status: "info" };
  }
  if (action === "admin_password_changed" || action === "admin_password_change_failed") {
    const success = action === "admin_password_changed";
    return {
      title: success ? "Admin password changed" : "Admin password change failed",
      description: success ? "The admin password was updated." : "An admin password change was rejected.",
      status: success ? "success" : "failed"
    };
  }
  if (action === "menu_csv_imported") {
    return {
      title: "Menu CSV imported",
      description: `${Number(details.imported ?? 0)} imported, ${Number(details.updated ?? 0)} updated, ${Number(details.skipped ?? 0)} skipped.`,
      status: "info"
    };
  }
  if (action === "menu_item_created" || action === "menu_item_updated") {
    const itemName = typeof details.itemName === "string" ? details.itemName : "Menu item";
    return {
      title: action === "menu_item_created" ? "Menu item added" : "Menu item updated",
      description: `${itemName}${typeof details.price === "number" ? ` | ${details.price} TK` : ""}`,
      status: "info"
    };
  }
  if (action === "menu_item_archived" || action === "menu_item_deleted") {
    return {
      title: action === "menu_item_archived" ? "Menu item archived" : "Menu item deleted",
      description: typeof details.entityId === "string" ? `Menu item ID ${details.entityId}` : "Menu item changed.",
      status: "info"
    };
  }
  if (action === "receipt_settings_updated") {
    return { title: "Receipt settings updated", description: "Receipt branding, address, phone, email, logo, or QR settings were saved.", status: "info" };
  }
  if (action === "printer_setting_updated") {
    return { title: "Printer setting updated", description: `Selected printer: ${String(details.printerName ?? "None")}`, status: "info" };
  }
  if (action === "inventory_tracking_setting_updated") {
    return { title: "Inventory tracking setting updated", description: `Track Inventory is ${details.enabled ? "on" : "off"}.`, status: "info" };
  }
  if (action === "inventory_csv_imported") {
    return {
      title: "Inventory CSV imported",
      description: `${Number(details.recipesImported ?? 0)} recipes imported, ${Number(details.recipesUpdated ?? 0)} updated, ${Number(details.inventoryItemsCreated ?? 0)} inventory items created.`,
      status: Number(details.errors?.toString?.().length ?? 0) > 0 ? "failed" : "success"
    };
  }
  if (action.startsWith("inventory_item_")) {
    return { title: inventoryTitle(action), description: String(details.itemName ?? details.name ?? "Inventory item updated."), status: "info" };
  }
  if (action.startsWith("inventory_category_")) {
    return { title: inventoryTitle(action), description: String(details.name ?? "Inventory category updated."), status: "info" };
  }
  if (action === "inventory_restock_created") {
    return { title: "Restock entry added", description: `${String(details.itemName ?? "Inventory item")} | ${String(details.quantity ?? "")}`, status: "success" };
  }
  if (action === "inventory_price_record_created") {
    return { title: "Inventory price record added", description: `${String(details.itemName ?? "Inventory item")} | ${String(details.pricePerBase ?? "")} per base unit`, status: "success" };
  }
  if (action.startsWith("cost_category_")) {
    return { title: inventoryTitle(action), description: String(details.name ?? "Cost category updated."), status: "info" };
  }
  if (action === "cost_record_created") {
    return { title: "Cost record added", description: `${String(details.costName ?? "Cost")} | ${String(details.amount ?? "")} TK`, status: "success" };
  }
  if (action === "order_cost_snapshot_created") {
    return { title: "Order cost snapshot saved", description: `Revenue ${String(details.revenue ?? 0)} TK | Raw cost ${String(details.rawCost ?? 0)} TK`, status: "info" };
  }
  if (action === "table_count_updated") {
    return { title: "Table count updated", description: `${Number(details.totalTables ?? 0)} tables configured.`, status: "info" };
  }
  if (action === "host_names_updated") {
    return { title: "Host names updated", description: `${Number(details.count ?? 0)} host name${Number(details.count ?? 0) === 1 ? "" : "s"} saved.`, status: "info" };
  }
  if (action === "email_notification_settings_updated") {
    return { title: "Email notification settings updated", description: details.enabled ? `Enabled for ${String(details.recipientEmail ?? "recipient")}.` : "Email notifications disabled.", status: "info" };
  }
  if (action === "gmail_connection_cleared") {
    return { title: "Gmail connection cleared", description: "Saved Gmail connection was removed.", status: "info" };
  }
  return { title: friendlyAction(action), description: detailsSummary(details), status: "info" };
}

function friendlyPanel(panel: string): string {
  const labels: Record<string, string> = {
    admin: "Admin panel",
    completedOrders: "Completed Orders",
    cancelledOrders: "Cancelled Orders"
  };
  return labels[panel] ?? friendlyAction(panel);
}

function friendlyAction(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inventoryTitle(action: string): string {
  const labels: Record<string, string> = {
    inventory_item_created: "Inventory item added",
    inventory_item_updated: "Inventory item updated",
    inventory_category_created: "Inventory category added",
    inventory_category_updated: "Inventory category updated",
    cost_category_created: "Cost category added",
    cost_category_updated: "Cost category updated"
  };
  return labels[action] ?? friendlyAction(action);
}

function reasonText(details: AuditDetails): string {
  return typeof details.reason === "string" && details.reason.trim() ? `Reason: ${details.reason.trim()}` : "No reason recorded.";
}

function detailsSummary(details: AuditDetails): string {
  const entries = Object.entries(details).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (entries.length === 0) return "No extra details.";
  return entries.map(([key, value]) => `${friendlyAction(key)}: ${String(value)}`).join(" | ");
}

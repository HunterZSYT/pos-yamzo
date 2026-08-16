import type Database from "better-sqlite3";
import type { HistoryRange, KotHistoryEntry, SwapHistoryEntry } from "../../shared/types.js";

export function listKotHistory(db: Database.Database, range: HistoryRange = {}): KotHistoryEntry[] {
  const { clause, params } = dateClause("pj.created_at", range);
  const rows = db.prepare(
    `SELECT pj.id AS print_job_id, pj.type, pj.content, pj.printer, pj.status,
            pj.error_message, pj.created_at, pj.printed_at,
            COALESCE(pjc.order_id, opr.order_id) AS order_id,
            COALESCE(pjc.operator, o.host_name, 'Cashier') AS operator,
            pjc.reason, m.name AS manager_name,
            o.order_number, o.source, o.table_number, o.guest_count,
            (SELECT COUNT(*) FROM print_attempts pa WHERE pa.print_job_id = pj.id) AS attempt_count,
            (SELECT COUNT(*) FROM print_attempts pa WHERE pa.print_job_id = pj.id AND pa.success = 1) AS successful_print_count
     FROM print_jobs pj
     LEFT JOIN print_job_context pjc ON pjc.print_job_id = pj.id
     LEFT JOIN order_print_requirements opr ON opr.print_job_id = pj.id
     LEFT JOIN orders o ON o.id = COALESCE(pjc.order_id, opr.order_id)
     LEFT JOIN managers m ON m.id = pjc.manager_id
     WHERE pj.type IN ('kot', 'kot_reprint', 'addition_kot', 'void_kot')
       AND COALESCE(pjc.order_id, opr.order_id) IS NOT NULL
       ${clause}
     ORDER BY pj.created_at DESC, pj.id DESC
     LIMIT 500`
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    printJobId: Number(row.print_job_id),
    orderId: Number(row.order_id),
    orderNumber: String(row.order_number),
    source: String(row.source),
    tableNumber: row.table_number ? String(row.table_number) : null,
    guestCount: Number(row.guest_count ?? 1),
    kotType: String(row.type),
    items: kitchenLines(String(row.content)),
    printer: row.printer ? String(row.printer) : null,
    operator: String(row.operator),
    managerName: row.manager_name ? String(row.manager_name) : null,
    reason: row.reason ? String(row.reason) : null,
    status: String(row.status) as KotHistoryEntry["status"],
    errorMessage: row.error_message ? String(row.error_message) : null,
    requestedAt: String(row.created_at),
    printedAt: row.printed_at ? String(row.printed_at) : null,
    attemptCount: Number(row.attempt_count ?? 0),
    successfulPrintCount: Number(row.successful_print_count ?? 0),
    reprintCount: Math.max(0, Number(row.attempt_count ?? 0) - 1) + (String(row.type).includes("reprint") ? 1 : 0)
  }));
}

export function listSwapHistory(db: Database.Database, range: HistoryRange = {}): SwapHistoryEntry[] {
  return listAdjustmentHistory(db, "swap", range);
}

export function listCancelledKotHistory(db: Database.Database, range: HistoryRange = {}): SwapHistoryEntry[] {
  return listAdjustmentHistory(db, "cancel", range);
}

function listAdjustmentHistory(db: Database.Database, eventKind: "swap" | "cancel", range: HistoryRange): SwapHistoryEntry[] {
  const { clause, params } = dateClause("se.created_at", range);
  const rows = db.prepare(
    `SELECT se.*, o.order_number, o.source, o.table_number, o.guest_count,
            pj.status AS adjustment_status,
            (SELECT COUNT(*) FROM print_attempts pa WHERE pa.print_job_id = se.adjustment_print_job_id AND pa.success = 1) AS successful_print_count
     FROM swap_events se
     JOIN orders o ON o.id = se.order_id
     JOIN print_jobs pj ON pj.id = se.adjustment_print_job_id
     WHERE se.event_kind = ? ${clause}
     ORDER BY se.created_at DESC, se.id DESC
     LIMIT 500`
  ).all(eventKind, ...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    orderId: Number(row.order_id),
    orderNumber: String(row.order_number),
    source: String(row.source),
    tableNumber: row.table_number ? String(row.table_number) : null,
    guestCount: Number(row.guest_count ?? 1),
    eventKind: String(row.event_kind) as SwapHistoryEntry["eventKind"],
    originalName: String(row.original_name),
    originalQuantity: Number(row.original_quantity),
    replacementName: row.replacement_name ? String(row.replacement_name) : null,
    replacementQuantity: row.replacement_quantity === null ? null : Number(row.replacement_quantity),
    reason: String(row.reason),
    managerName: String(row.manager_name),
    operator: String(row.operator),
    originalKotPrintJobId: row.original_kot_print_job_id === null ? null : Number(row.original_kot_print_job_id),
    adjustmentPrintJobId: Number(row.adjustment_print_job_id),
    adjustmentStatus: String(row.adjustment_status) as SwapHistoryEntry["adjustmentStatus"],
    successfulPrintCount: Number(row.successful_print_count ?? 0),
    createdAt: String(row.created_at)
  }));
}

function dateClause(column: string, range: HistoryRange): { clause: string; params: string[] } {
  const params: string[] = [];
  let clause = "";
  if (range.startDate) {
    clause += ` AND date(${column}, 'localtime') >= date(?)`;
    params.push(range.startDate);
  }
  if (range.endDate) {
    clause += ` AND date(${column}, 'localtime') <= date(?)`;
    params.push(range.endDate);
  }
  return { clause, params };
}

function kitchenLines(content: string): string[] {
  return content.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\s+x\s+/i.test(line) || /^(REMOVE|ADD|CHANGE):/i.test(line))
    .slice(0, 12);
}

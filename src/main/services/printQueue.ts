import type Database from "better-sqlite3";
import type { PrintJob, PrintJobType } from "../../shared/types.js";

export function enqueuePrintJob(
  db: Database.Database,
  type: PrintJobType,
  content: string,
  printer?: string | null
): number {
  const result = db
    .prepare("INSERT INTO print_jobs (type, content, printer, status) VALUES (?, ?, ?, 'pending')")
    .run(type, content, printer ?? null);
  return Number(result.lastInsertRowid);
}

export function markPrintJobFailed(db: Database.Database, id: number, message: string): void {
  db.prepare(
    "UPDATE print_jobs SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(message, id);
}

export function markPrintJobPrinted(db: Database.Database, id: number): void {
  db.prepare(
    "UPDATE print_jobs SET status = 'printed', printed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
}

export function listPrintJobs(db: Database.Database, status?: string): PrintJob[] {
  const rows = status
    ? db.prepare("SELECT * FROM print_jobs WHERE status = ? ORDER BY created_at DESC").all(status)
    : db.prepare("SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 100").all();
  return rows.map(toPrintJob);
}

export function getPrintJob(db: Database.Database, id: number): PrintJob {
  const row = db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(id);
  if (!row) {
    throw new Error("Print job not found.");
  }
  return toPrintJob(row);
}

export function markPrintJobRetry(db: Database.Database, id: number): void {
  db.prepare(
    "UPDATE print_jobs SET status = 'retry', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
}

function toPrintJob(row: unknown): PrintJob {
  const job = row as {
    id: number;
    type: PrintJob["type"];
    content: string;
    printer: string | null;
    status: PrintJob["status"];
    error_message: string | null;
    created_at: string;
  };
  return {
    id: job.id,
    type: job.type,
    content: job.content,
    printer: job.printer,
    status: job.status,
    errorMessage: job.error_message,
    createdAt: job.created_at
  };
}

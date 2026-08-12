import type Database from "better-sqlite3";
import type { PrintJob, PrintJobType } from "../../shared/types.js";

export function enqueuePrintJob(
  db: Database.Database,
  type: PrintJobType,
  content: string,
  printer?: string | null,
  context?: {
    orderId?: number;
    operator?: string;
    managerId?: number;
    reason?: string;
    relatedPrintJobId?: number;
  }
): number {
  const result = db
    .prepare("INSERT INTO print_jobs (type, content, printer, status) VALUES (?, ?, ?, 'pending')")
    .run(type, content, printer ?? null);
  const id = Number(result.lastInsertRowid);
  if (context) {
    db.prepare(
      `INSERT INTO print_job_context
        (print_job_id, order_id, operator, manager_id, reason, related_print_job_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      context.orderId ?? null,
      context.operator?.trim() || null,
      context.managerId ?? null,
      context.reason?.trim() || null,
      context.relatedPrintJobId ?? null
    );
  }
  return id;
}

export function beginPrintAttempt(db: Database.Database, printJobId: number): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt FROM print_attempts WHERE print_job_id = ?"
  ).get(printJobId) as { next_attempt: number };
  const result = db.prepare(
    "INSERT INTO print_attempts (print_job_id, attempt_number) VALUES (?, ?)"
  ).run(printJobId, row.next_attempt);
  return Number(result.lastInsertRowid);
}

export function finishPrintAttempt(
  db: Database.Database,
  attemptId: number,
  success: boolean,
  errorMessage?: string
): void {
  db.prepare(
    `UPDATE print_attempts
     SET completed_at = CURRENT_TIMESTAMP, success = ?, error_message = ?
     WHERE id = ? AND completed_at IS NULL`
  ).run(success ? 1 : 0, success ? null : (errorMessage ?? "Printing failed.").slice(0, 500), attemptId);
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

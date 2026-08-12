import type Database from "better-sqlite3";
import type { OrderSummary, WebsiteInitialKotState } from "../../shared/types.js";
import {
  claimWebsiteInitialKotPrint,
  ensureWebsiteInitialKot,
  finishWebsiteInitialKotPrint,
  listPendingWebsiteInitialKots,
  queueWebsiteOrderLifecycleForPosOrder
} from "../domain/websiteOrders.js";
import { getOrderSummary } from "../domain/orders.js";
import { printJob, retryPrintJob } from "./printer.js";

export interface WebsiteInitialKotResult {
  order: OrderSummary;
  state: WebsiteInitialKotState;
  printJobId: number;
  attempted: boolean;
}

export async function printWebsiteInitialKot(
  db: Database.Database,
  remoteId: string,
  retry = false
): Promise<WebsiteInitialKotResult> {
  const identity = ensureWebsiteInitialKot(db, remoteId);
  const claimed = claimWebsiteInitialKotPrint(db, remoteId, retry);
  if (!claimed) {
    const current = ensureWebsiteInitialKot(db, remoteId);
    return {
      order: getOrderSummary(db, current.orderId),
      state: current.state,
      printJobId: current.printJobId,
      attempted: false
    };
  }

  const printed = retry
    ? await retryPrintJob(db, claimed.printJobId)
    : await printJob(db, claimed.printJobId);
  const completed = finishWebsiteInitialKotPrint(db, claimed.printJobId, printed);
  if (printed) {
    queueWebsiteOrderLifecycleForPosOrder(
      db,
      completed.orderId,
      "preparing",
      "Kitchen KOT confirmed in Yamzo POS"
    );
  }
  return {
    order: getOrderSummary(db, completed.orderId),
    state: completed.state,
    printJobId: completed.printJobId,
    attempted: true
  };
}

export async function printPendingWebsiteInitialKots(
  db: Database.Database
): Promise<WebsiteInitialKotResult[]> {
  const pending = listPendingWebsiteInitialKots(db);
  const results: WebsiteInitialKotResult[] = [];
  for (const identity of pending) {
    results.push(await printWebsiteInitialKot(db, identity.remoteId));
  }
  return results;
}

export async function retryWebsiteInitialKotForOrder(
  db: Database.Database,
  orderId: number
): Promise<WebsiteInitialKotResult> {
  if (!Number.isInteger(orderId) || orderId < 1) {
    throw new Error("Website order is invalid.");
  }
  const row = db.prepare(
    "SELECT website_order_id FROM website_initial_kots WHERE pos_order_id = ?"
  ).get(orderId) as { website_order_id: string } | undefined;
  if (!row) throw new Error("This order does not have an initial website Kitchen KOT.");
  return printWebsiteInitialKot(db, row.website_order_id, true);
}

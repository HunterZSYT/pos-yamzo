import type Database from "better-sqlite3";
import type { WebsiteOrderSnapshot, WebsiteOutboxEvent } from "../../shared/types.js";
import {
  getWebsiteSyncCursor,
  importWebsiteOrderSnapshots,
  listPendingWebsiteOutbox,
  markWebsiteOutboxFailed,
  markWebsiteOutboxSent,
  setWebsiteSyncCursor,
  type WebsiteOrderImportResult
} from "../domain/websiteOrders.js";

export interface WebsiteOrderPullResult {
  orders: WebsiteOrderSnapshot[];
  nextCursor: string | null;
}

/**
 * Main-process boundary for a future authenticated Supabase adapter.
 * Implementations receive no database handle and must never be exposed through preload.
 */
export interface WebsiteOrderSyncTransport {
  pullOrders(cursor: string | null, limit: number): Promise<WebsiteOrderPullResult>;
  pushEvents(events: WebsiteOutboxEvent[]): Promise<{ acceptedEventIds: number[] }>;
}

export interface WebsiteOrderSyncResult extends WebsiteOrderImportResult {
  pushed: number;
  cursor: string | null;
}

export class WebsiteOrderSyncService {
  constructor(
    private readonly db: Database.Database,
    private readonly transport: WebsiteOrderSyncTransport
  ) {}

  async syncOnce(): Promise<WebsiteOrderSyncResult> {
    const cursor = getWebsiteSyncCursor(this.db);
    const pulled = await this.transport.pullOrders(cursor, 100);
    const imported = importWebsiteOrderSnapshots(this.db, pulled.orders);
    setWebsiteSyncCursor(this.db, pulled.nextCursor);

    const events = listPendingWebsiteOutbox(this.db, 50);
    if (events.length === 0) return { ...imported, pushed: 0, cursor: pulled.nextCursor };
    try {
      const pushed = await this.transport.pushEvents(events);
      const eventIds = new Set(events.map((event) => event.id));
      const accepted = Array.from(new Set(pushed.acceptedEventIds)).filter((id) => eventIds.has(id));
      markWebsiteOutboxSent(this.db, accepted);
      const rejected = events.map((event) => event.id).filter((id) => !accepted.includes(id));
      if (rejected.length > 0) markWebsiteOutboxFailed(this.db, rejected, "Remote sync did not acknowledge the event.");
      return { ...imported, pushed: accepted.length, cursor: pulled.nextCursor };
    } catch (error) {
      markWebsiteOutboxFailed(
        this.db,
        events.map((event) => event.id),
        error instanceof Error ? error.message : "Website order sync failed."
      );
      throw error;
    }
  }
}

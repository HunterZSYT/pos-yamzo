import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { openMemoryDatabase } from "../src/main/database/connection";
import { WebsiteOrderConnectionManager } from "../src/main/services/websiteOrderConnection";
import type { WebsiteOrderSyncResult } from "../src/main/services/websiteOrderSync";

const emptySync: WebsiteOrderSyncResult = {
  inserted: 0,
  updated: 0,
  unchanged: 0,
  ignoredStale: 0,
  pushed: 0,
  cursor: null,
};

function managerWithSync(syncOnce: () => Promise<WebsiteOrderSyncResult>) {
  const db = openMemoryDatabase();
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const manager = new WebsiteOrderConnectionManager(db, {
    loadTerminalPrivateKey: () => privateKey,
  });
  (manager as unknown as { syncService: { syncOnce: typeof syncOnce } }).syncService = {
    syncOnce,
  };
  return { db, manager };
}

describe("website order connection recovery", () => {
  it("coalesces duplicate Realtime wakes into one in-flight signed recovery sync", async () => {
    let release: ((result: WebsiteOrderSyncResult) => void) | undefined;
    const syncOnce = vi.fn(() => new Promise<WebsiteOrderSyncResult>((resolve) => {
      release = resolve;
    }));
    const { db, manager } = managerWithSync(syncOnce);

    try {
      const first = manager.syncNow("realtime");
      const duplicate = manager.syncNow("realtime");
      expect(syncOnce).toHaveBeenCalledTimes(1);

      release?.(emptySync);
      await expect(Promise.all([first, duplicate])).resolves.toEqual([emptySync, emptySync]);
      expect(syncOnce).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().connection).toBe("connected");
    } finally {
      manager.stop();
      db.close();
    }
  });

  it("clears a failed in-flight sync so an offline recovery attempt can succeed", async () => {
    const syncOnce = vi
      .fn<() => Promise<WebsiteOrderSyncResult>>()
      .mockRejectedValueOnce(new Error("The Yamzo website network could not be reached."))
      .mockResolvedValueOnce(emptySync);
    const { db, manager } = managerWithSync(syncOnce);

    try {
      await expect(manager.syncNow("reconnect")).rejects.toThrow("could not be reached");
      expect(manager.getStatus().connection).toBe("offline");
      await expect(manager.syncNow("reconnect")).resolves.toEqual(emptySync);
      expect(syncOnce).toHaveBeenCalledTimes(2);
      expect(manager.getStatus().connection).toBe("connected");
    } finally {
      manager.stop();
      db.close();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { keyValueKeys, SqliteKeyValueStore } from "./key-value";

describe("SqliteKeyValueStore", () => {
  test("stores and loads typed values", async () => {
    const database = new Database(":memory:");
    const store = new SqliteKeyValueStore(database);
    const key = keyValueKeys.npcSyncSince("https://npubx.cash", "pubkey-1");

    await store.set(key, 1234);

    await expect(store.get(key)).resolves.toBe(1234);
  });

  test("returns null for missing keys", async () => {
    const database = new Database(":memory:");
    const store = new SqliteKeyValueStore(database);
    const key = keyValueKeys.npcSyncSince("https://npubx.cash", "pubkey-2");

    await expect(store.get(key)).resolves.toBeNull();
  });
});

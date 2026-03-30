import { Database } from "bun:sqlite";

export interface KeyValueKey<T> {
  key: string;
  parse(value: string): T;
  serialize(value: T): string;
}

export interface KeyValueEntry<T> {
  get(): Promise<T | null>;
  set(value: T): Promise<void>;
}

export interface RequiredKeyValueEntry<T> {
  get(): Promise<T>;
  set(value: T): Promise<void>;
}

function createIntegerKey(key: string): KeyValueKey<number> {
  return {
    key,
    parse(value: string): number {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid integer value for key '${key}'`);
      }
      return parsed;
    },
    serialize(value: number): string {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid integer value for key '${key}'`);
      }
      return value.toString();
    },
  };
}

export const keyValueKeys = {
  npcSyncSince(baseUrl: string, pubkey: string): KeyValueKey<number> {
    return createIntegerKey(`npc.syncSince:${baseUrl}:${pubkey}`);
  },
} as const;

export function withDefault<T>(
  entry: KeyValueEntry<T>,
  fallbackValue: T,
): RequiredKeyValueEntry<T> {
  return {
    get: async () => (await entry.get()) ?? fallbackValue,
    set: entry.set,
  };
}

export class SqliteKeyValueStore {
  constructor(private readonly database: Database) {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS cocod_key_value (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async get<T>(key: KeyValueKey<T>): Promise<T | null> {
    const row = this.database
      .query("SELECT value FROM cocod_key_value WHERE key = ?1")
      .get(key.key) as { value: string } | null;

    if (!row) {
      return null;
    }

    return key.parse(row.value);
  }

  async set<T>(key: KeyValueKey<T>, value: T): Promise<void> {
    this.database.run(
      `
        INSERT INTO cocod_key_value (key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      [key.key, key.serialize(value)],
    );
  }

  entry<T>(key: KeyValueKey<T>): KeyValueEntry<T> {
    return {
      get: () => this.get(key),
      set: (value: T) => this.set(key, value),
    };
  }
}

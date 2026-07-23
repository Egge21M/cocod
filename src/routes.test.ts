import { describe, expect, test } from "bun:test";

import {
  cheapestFeeIndex,
  createRouteHandlers,
  formatBtcAmount,
  parseOnchainTarget,
  pickPayableMint,
  sanitizeHistoryEntry,
} from "./routes";
import { DaemonStateManager } from "./utils/state";

function unlockedStateManager(): DaemonStateManager {
  const stateManager = new DaemonStateManager();
  const fakeManager = {} as unknown as import("@cashu/coco-core").Manager;
  const fakeNpcAccount = {} as unknown as import("coco-cashu-plugin-npc").NPCAccountApi;
  stateManager.setUnlocked(
    fakeManager,
    "https://mint.example.com",
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5, 6]),
    fakeNpcAccount,
  );
  return stateManager;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("routes", () => {
  test("/init validates invalid mnemonic", async () => {
    const stateManager = new DaemonStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/init"]!.POST!(
      new Request("http://localhost/init", {
        method: "POST",
        body: JSON.stringify({ mnemonic: "invalid mnemonic" }),
      }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid mnemonic");
  });

  test("/unlock requires passphrase", async () => {
    const stateManager = new DaemonStateManager();
    stateManager.setLocked("encrypted", "https://mint.example.com");
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/unlock"]!.POST!(
      new Request("http://localhost/unlock", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Passphrase required");
  });

  test("/x-cashu/parse requires request field", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/x-cashu/parse"]!.POST!(
      new Request("http://localhost/x-cashu/parse", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Request is required");
  });

  test("/send/cashu rejects a non-positive amount", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/cashu"]!.POST!(
      postJson("/send/cashu", { amount: 0 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount must be a positive number");
  });

  test("/send/cashu rejects an invalid --to target before spending", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/cashu"]!.POST!(
      postJson("/send/cashu", { amount: 5, to: "not-a-target" }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid Nostr target (expected npub, nprofile, or hex pubkey)");
  });

  test("/send/creq rejects a non-positive amount option", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", { request: "creqA...", amount: -1 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount must be a positive number");
  });

  test("/send/bolt12 rejects a non-positive amount option", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/bolt12"]!.POST!(
      postJson("/send/bolt12", { offer: "lno1...", amount: 0 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount must be a positive number");
  });

  test("/mints/add rejects an invalid URL", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/mints/add"]!.POST!(
      postJson("/mints/add", { url: "not a url" }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid mint URL");
  });

  test("/send/creq requires request field", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", {}),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Request is required");
  });

  test("/send/onchain requires address", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/onchain"]!.POST!(
      postJson("/send/onchain", { amount: 21 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Address is required");
  });

  test("/send/onchain rejects invalid address", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/onchain"]!.POST!(
      postJson("/send/onchain", { address: "not-an-address", amount: 21 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid Bitcoin address");
  });

  test("/send/onchain requires an amount when the target has none", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/onchain"]!.POST!(
      postJson("/send/onchain", { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount must be a positive number");
  });

  test("/send/bolt12 requires offer field", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/bolt12"]!.POST!(
      postJson("/send/bolt12", {}),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Offer is required");
  });

  test("/mints/default requires url field", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/mints/default"]!.POST!(
      postJson("/mints/default", {}),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("URL is required");
  });

  test("/receive/creq requires a positive amount", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/creq"]!.POST!(
      postJson("/receive/creq", { amount: 0 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount must be a positive number");
  });
});

describe("route helpers", () => {
  test("formatBtcAmount trims trailing zeros", () => {
    expect(formatBtcAmount(123)).toBe("0.00000123");
    expect(formatBtcAmount(100000000)).toBe("1");
    expect(formatBtcAmount(150000000)).toBe("1.5");
  });

  test("pickPayableMint prefers explicit, then fallback, then first", () => {
    const mints = ["https://a.example.com", "https://b.example.com"];
    expect(pickPayableMint(mints, "https://b.example.com", "https://a.example.com")).toBe(
      "https://b.example.com",
    );
    expect(pickPayableMint(mints, "https://c.example.com", "https://a.example.com")).toBeNull();
    expect(pickPayableMint(mints, undefined, "https://b.example.com")).toBe(
      "https://b.example.com",
    );
    expect(pickPayableMint(mints, undefined, "https://c.example.com")).toBe(
      "https://a.example.com",
    );
    expect(pickPayableMint([], undefined, "https://a.example.com")).toBeNull();
  });

  test("parseOnchainTarget handles bare addresses and bitcoin: URIs", () => {
    const address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    expect(parseOnchainTarget(address)).toEqual({ address });
    expect(parseOnchainTarget(`bitcoin:${address}?amount=0.00000021`)).toEqual({
      address,
      amountSats: 21,
    });
    expect(parseOnchainTarget(`BITCOIN:${address}?AMOUNT=0.00000021`)).toEqual({
      address,
      amountSats: 21,
    });
    // all-uppercase QR form normalizes to lowercase bech32
    expect(parseOnchainTarget(address.toUpperCase())).toEqual({ address });
    // BIP-173 forbids mixed-case bech32
    expect(parseOnchainTarget("bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBeNull();
    expect(parseOnchainTarget("garbage")).toBeNull();
  });

  test("cheapestFeeIndex picks the lowest fee reserve", () => {
    const options = [
      { fee_index: 0, fee_reserve: { toNumber: () => 500 } },
      { fee_index: 1, fee_reserve: { toNumber: () => 120 } },
      { fee_index: 2, fee_reserve: { toNumber: () => 900 } },
    ];
    expect(cheapestFeeIndex(options)).toBe(1);
    expect(cheapestFeeIndex([])).toBeUndefined();
  });

  test("sanitizeHistoryEntry strips token and proofs", () => {
    const entry = {
      id: "send:1",
      type: "send",
      amount: "21",
      token: { mint: "https://mint.example.com", proofs: [{ secret: "s3cret" }] },
      proofs: [{ secret: "s3cret" }],
    };
    expect(sanitizeHistoryEntry(entry)).toEqual({ id: "send:1", type: "send", amount: "21" });
    expect(sanitizeHistoryEntry(null)).toBeNull();
    expect(sanitizeHistoryEntry("plain")).toBe("plain");
  });
});

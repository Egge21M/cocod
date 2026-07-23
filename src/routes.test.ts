import { describe, expect, test } from "bun:test";
import { toAmount, type HistoryEntry } from "@cashu/coco-core";
import { nip19 } from "nostr-tools";

import {
  cheapestFeeIndex,
  createRouteHandlers,
  formatBtcAmount,
  isPositiveInt,
  parseOnchainTarget,
  pickPayableMint,
  sanitizeHistoryEntry,
} from "./routes";
import { decodeNostrTarget } from "./utils/nostr";
import { DaemonStateManager } from "./utils/state";

function unlockedStateManager(manager?: unknown): DaemonStateManager {
  const stateManager = new DaemonStateManager();
  const fakeManager = (manager ?? {}) as import("@cashu/coco-core").Manager;
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
    expect(body.error).toBe("Amount must be a positive integer");
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
    expect(body.error).toBe("Amount must be a positive integer");
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
    expect(body.error).toBe("Amount must be a positive integer");
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
    expect(body.error).toBe("Amount must be a positive integer");
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

  test("/receive/bolt11 rejects a non-integer amount", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/bolt11"]!.POST!(
      postJson("/receive/bolt11", { amount: null }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount must be a positive integer");
  });

  test("/receive/bolt12 rejects an invalid amount instead of dropping it", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/bolt12"]!.POST!(
      postJson("/receive/bolt12", { amount: null }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount must be a positive integer");
  });

  test("/send/creq rejects a locked request on non-nostr transports", async () => {
    const stubManager = {
      paymentRequests: {
        parse: async () => ({
          unit: "sat",
          amount: undefined,
          payableMints: ["https://mint.example.com"],
          transport: { type: "http", url: "https://receiver.example.com/pay" },
          paymentRequest: { id: "abc", nut10: { kind: "P2PK", data: "02deadbeef" } },
        }),
      },
    };
    const stateManager = unlockedStateManager(stubManager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", { request: "creqA...", amount: 21 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Locked payment requests are only supported over nostr transport");
  });

  test("/send/creq rejects non-P2PK spending conditions", async () => {
    const stubManager = {
      paymentRequests: {
        parse: async () => ({
          unit: "sat",
          amount: undefined,
          payableMints: ["https://mint.example.com"],
          transport: {
            type: "nostr",
            target: "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
          },
          paymentRequest: { id: "abc", nut10: { kind: "HTLC", data: "deadbeef" } },
        }),
      },
    };
    const stateManager = unlockedStateManager(stubManager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", { request: "creqA...", amount: 21 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Unsupported spending condition: HTLC");
  });

  test("/send/creq rejects P2PK requests with constraint tags", async () => {
    const stubManager = {
      paymentRequests: {
        parse: async () => ({
          unit: "sat",
          amount: undefined,
          payableMints: ["https://mint.example.com"],
          transport: {
            type: "nostr",
            target: "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
          },
          paymentRequest: {
            id: "abc",
            nut10: { kind: "P2PK", data: "02deadbeef", tags: [["locktime", "1700000000"]] },
          },
        }),
      },
    };
    const stateManager = unlockedStateManager(stubManager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", { request: "creqA...", amount: 21 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("P2PK requests with additional constraints (tags) are not supported");
  });

  test("/send/creq rejects an explicit --mint-url the request cannot use", async () => {
    const stubManager = {
      paymentRequests: {
        parse: async () => ({
          unit: "sat",
          amount: undefined,
          payableMints: ["https://other.example.com"],
          transport: {
            type: "nostr",
            target: "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
          },
          paymentRequest: { id: "abc" },
        }),
      },
    };
    const stateManager = unlockedStateManager(stubManager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", {
        request: "creqA...",
        amount: 21,
        mintUrl: "https://mint.example.com",
      }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Mint https://mint.example.com does not satisfy request (request specifies different mints, or mint balance is insufficient).",
    );
  });

  test("/send/creq requires --amount for an amountless nostr request", async () => {
    const stubManager = {
      paymentRequests: {
        parse: async () => ({
          unit: "sat",
          amount: undefined,
          payableMints: ["https://mint.example.com"],
          transport: {
            type: "nostr",
            target: "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
          },
          paymentRequest: { id: "abc" },
        }),
      },
    };
    const stateManager = unlockedStateManager(stubManager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", { request: "creqA..." }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Request has no amount. Use --amount to specify one");
  });

  test("/send/creq rejects a conflicting --amount", async () => {
    const stubManager = {
      paymentRequests: {
        parse: async () => ({
          unit: "sat",
          amount: { toNumber: () => 100 },
          payableMints: ["https://mint.example.com"],
          transport: {
            type: "nostr",
            target: "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
          },
          paymentRequest: { id: "abc" },
        }),
      },
    };
    const stateManager = unlockedStateManager(stubManager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/creq"]!.POST!(
      postJson("/send/creq", { request: "creqA...", amount: 50 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Amount does not match the request amount (100 sats)");
  });

  test("/history strips tokens from entries at the route boundary", async () => {
    const entryWithToken = {
      id: "send:1",
      type: "send",
      amount: "21",
      token: { mint: "https://mint.example.com", proofs: [{ secret: "s3cret" }] },
    };
    const stubManager = {
      history: { getPaginatedHistory: async () => [entryWithToken] },
    };
    const stateManager = unlockedStateManager(stubManager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/history"]!.GET!(
      new Request("http://localhost/history"),
      stateManager.getState(),
    );

    const body = (await response.json()) as { output: Record<string, unknown>[] };
    expect(response.status).toBe(200);
    expect(body.output).toHaveLength(1);
    expect(body.output[0]).not.toHaveProperty("token");
    expect(body.output[0]).toMatchObject({ id: "send:1", amount: "21" });
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
    expect(body.error).toBe("Amount must be a positive integer");
  });
});

describe("route helpers", () => {
  test("formatBtcAmount trims trailing zeros", () => {
    expect(formatBtcAmount(123)).toBe("0.00000123");
    expect(formatBtcAmount(100000000)).toBe("1");
    expect(formatBtcAmount(150000000)).toBe("1.5");
  });

  test("pickPayableMint prefers the fallback, then the first payable mint", () => {
    const mints = ["https://a.example.com", "https://b.example.com"];
    expect(pickPayableMint(mints, "https://b.example.com")).toBe("https://b.example.com");
    expect(pickPayableMint(mints, "https://c.example.com")).toBe("https://a.example.com");
    expect(pickPayableMint([], "https://a.example.com")).toBeNull();
  });

  test("isPositiveInt accepts only positive integers", () => {
    expect(isPositiveInt(21)).toBe(true);
    expect(isPositiveInt(0)).toBe(false);
    expect(isPositiveInt(-1)).toBe(false);
    expect(isPositiveInt(10.5)).toBe(false);
    expect(isPositiveInt(NaN)).toBe(false);
    expect(isPositiveInt(null)).toBe(false);
    expect(isPositiveInt("21")).toBe(false);
  });

  test("decodeNostrTarget accepts hex, npub, and nprofile targets", () => {
    const hex = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
    expect(decodeNostrTarget(hex)).toEqual({ pubkey: hex, relays: [] });
    expect(decodeNostrTarget(hex.toUpperCase()).pubkey).toBe(hex);
    // npub encoding of the hex key above
    const npub = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
    expect(decodeNostrTarget(npub).pubkey).toBe(hex);
    const nprofile = nip19.nprofileEncode({ pubkey: hex, relays: ["wss://relay.example.com"] });
    expect(decodeNostrTarget(nprofile)).toEqual({
      pubkey: hex,
      relays: ["wss://relay.example.com"],
    });
    expect(() => decodeNostrTarget("garbage")).toThrow();
  });

  test("parseOnchainTarget rejects URIs with req- parameters", () => {
    const address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    expect(parseOnchainTarget(`bitcoin:${address}?req-pop=xyz&amount=0.00000021`)).toBeNull();
    expect(parseOnchainTarget(`bitcoin:${address}?REQ-POP=xyz`)).toBeNull();
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
      { fee_index: 0, fee_reserve: toAmount(500), estimated_blocks: 1 },
      { fee_index: 1, fee_reserve: toAmount(120), estimated_blocks: 12 },
      { fee_index: 2, fee_reserve: toAmount(900), estimated_blocks: 0 },
    ];
    expect(cheapestFeeIndex(options)).toBe(1);
    expect(cheapestFeeIndex([])).toBeUndefined();
  });

  test("sanitizeHistoryEntry strips the token", () => {
    const entry = {
      id: "send:1",
      type: "send",
      amount: "21",
      token: { mint: "https://mint.example.com", proofs: [{ secret: "s3cret" }] },
    } as unknown as HistoryEntry;
    expect(sanitizeHistoryEntry(entry)).toEqual({
      id: "send:1",
      type: "send",
      amount: "21",
    } as unknown as HistoryEntry);
  });
});

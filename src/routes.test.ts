import { describe, expect, test } from "bun:test";
import { toAmount, type Manager } from "@cashu/coco-core";

import { createRouteHandlers } from "./routes";
import { DaemonStateManager } from "./utils/state";

function unlockedStateManager(manager?: unknown): DaemonStateManager {
  const stateManager = new DaemonStateManager();
  const fakeManager = (manager ?? {}) as Manager;
  const fakeNpcAccount = {} as unknown as import("coco-cashu-plugin-npc").NPCAccountApi;
  stateManager.setUnlocked(
    fakeManager,
    "https://mint.example.com",
    new Uint8Array([1, 2, 3]),
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

function postRaw(path: string, body: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body,
  });
}

describe("routes", () => {
  test("/init validates invalid mnemonic", async () => {
    const stateManager = new DaemonStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/init"]!.POST!(
      postJson("/init", { mnemonic: "invalid mnemonic" }),
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
      postJson("/unlock", {}),
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
      postJson("/x-cashu/parse", {}),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Request is required");
  });

  test("/x-cashu routes reject creqB before the decoder can discard NUT-10", async () => {
    for (const path of ["/x-cashu/parse", "/x-cashu/handle"]) {
      let parseCalled = false;
      const manager = {
        paymentRequests: {
          parse: async () => {
            parseCalled = true;
            throw new Error("should not parse");
          },
        },
      };
      const stateManager = unlockedStateManager(manager);
      const routes = createRouteHandlers(stateManager);

      const response = await routes[path]!.POST!(
        postJson(path, { request: "CREQB1example" }),
        stateManager.getState(),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "creqB requests are disabled because the pinned Cashu decoder drops NUT-10 spending conditions",
      });
      expect(parseCalled).toBe(false);
    }
  });

  test("/x-cashu routes reject decoded NUT-10 locks before preparing proofs", async () => {
    for (const path of ["/x-cashu/parse", "/x-cashu/handle"]) {
      let prepareCalled = false;
      const manager = {
        paymentRequests: {
          parse: async () => ({
            paymentRequest: {
              nut10: {
                kind: "P2PK",
                data: "02example",
              },
            },
            amount: toAmount(21),
            unit: "sat",
            allowedMints: ["https://mint.example.com"],
            payableMints: ["https://mint.example.com"],
            transport: { type: "inband" },
          }),
          prepare: async () => {
            prepareCalled = true;
            throw new Error("should not prepare");
          },
        },
      };
      const stateManager = unlockedStateManager(manager);
      const routes = createRouteHandlers(stateManager);

      const response = await routes[path]!.POST!(
        postJson(path, { request: "creqAexample" }),
        stateManager.getState(),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "NUT-10-locked requests cannot be safely prepared by Coco 2.0.0-rc.2's payment-request API",
      });
      expect(prepareCalled).toBe(false);
    }
  });

  test("new POST routes reject malformed JSON and non-object bodies", async () => {
    const paths = [
      "/receive/onchain",
      "/receive/bolt12",
      "/send/onchain",
      "/send/bolt12",
      "/mints/default",
    ];

    for (const path of paths) {
      const stateManager = unlockedStateManager();
      const routes = createRouteHandlers(stateManager);

      for (const request of [postRaw(path, "{"), postJson(path, null)]) {
        const response = await routes[path]!.POST!(request, stateManager.getState());
        const body = (await response.json()) as { error?: string };
        expect(response.status).toBe(400);
        expect(body.error).toBe("Request body must be a JSON object");
      }
    }
  });

  test("/receive/onchain emits a BIP-321 address-and-amount URI", async () => {
    const address = "bc1qufgy354j3kmvuch987xe4s40836x3h0lg8f5n2";
    const manager = {
      mint: {
        checkPaymentMethodCapability: async () => ({
          supported: true,
          disabled: false,
          operation: "mint",
          nut: 4,
          method: "onchain",
          unit: "sat",
          minAmount: toAmount(1),
          maxAmount: toAmount(100_000_000),
        }),
      },
      quotes: {
        mint: {
          create: async () => ({ request: address, expiry: null }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/onchain"]!.POST!(
      postJson("/receive/onchain", { amount: 21 }),
      stateManager.getState(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      output: `bitcoin:${address}?amount=0.00000021`,
    });
  });

  test("/receive/onchain preserves a plain address when no amount is requested", async () => {
    const address = "bc1qexample";
    const manager = {
      quotes: {
        mint: {
          create: async () => ({ request: address, expiry: null }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/onchain"]!.POST!(
      postJson("/receive/onchain", {}),
      stateManager.getState(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: address });
  });

  test("receive quote lists return only safe requests accepted by the expiry policy", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      {
        path: "/receive/onchain/list",
        method: "onchain",
        quotes: [
          {
            method: "onchain",
            request: "bc1qolder",
            expiry: null,
            quoteId: "private-quote-id",
            pubkey: "linkable-pubkey",
            quoteData: { secret: "must-not-leak" },
            outputData: [{ secret: "proof-secret", blindingFactor: "blinding-factor" }],
          },
          { method: "onchain", request: "bc1qnewer", expiry: null },
          { method: "onchain", request: "bc1qzero", expiry: 0 },
          { method: "onchain", request: "bc1qexpiring", expiry: now + 3600 },
          { method: "onchain", request: "bc1qline\nforged", expiry: null },
        ],
        output: "bc1qolder\nbc1qnewer\nbc1qzero\nbc1qexpiring",
      },
      {
        path: "/receive/bolt12/list",
        method: "bolt12",
        quotes: [
          {
            method: "bolt12",
            request: "lno1noexpiry",
            expiry: null,
            quoteId: "private-quote-id",
            pubkey: "linkable-pubkey",
            quoteData: { secret: "must-not-leak" },
            outputData: [{ secret: "proof-secret", blindingFactor: "blinding-factor" }],
          },
          { method: "bolt12", request: "lno1future", expiry: now + 3600 },
          { method: "bolt12", request: "lno1zero", expiry: 0 },
          { method: "bolt12", request: "lno1expired", expiry: now - 1 },
          { method: "bolt12", request: "lno1escape\u001b[31m", expiry: null },
        ],
        output: "lno1noexpiry\nlno1future\nlno1zero",
      },
    ] as const;

    for (const testCase of cases) {
      let listedMethod: string | undefined;
      const manager = {
        quotes: {
          mint: {
            listPending: async (input: { method: string }) => {
              listedMethod = input.method;
              return testCase.quotes;
            },
          },
        },
      };
      const stateManager = unlockedStateManager(manager);
      const routes = createRouteHandlers(stateManager);

      const response = await routes[testCase.path]!.GET!(
        new Request(`http://localhost${testCase.path}`),
        stateManager.getState(),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: testCase.output });
      expect(listedMethod).toBe(testCase.method);
    }
  });

  test("/receive/onchain rejects amounts outside the mint's NUT-30 limits before quoting", async () => {
    for (const amount of [20, 201]) {
      let quoteCreated = false;
      const manager = {
        mint: {
          checkPaymentMethodCapability: async () => ({
            supported: true,
            disabled: false,
            operation: "mint",
            nut: 4,
            method: "onchain",
            unit: "sat",
            minAmount: toAmount(21),
            maxAmount: toAmount(200),
          }),
        },
        quotes: {
          mint: {
            create: async () => {
              quoteCreated = true;
              return { request: "bc1qexample", expiry: null };
            },
          },
        },
      };
      const stateManager = unlockedStateManager(manager);
      const routes = createRouteHandlers(stateManager);

      const response = await routes["/receive/onchain"]!.POST!(
        postJson("/receive/onchain", { amount }),
        stateManager.getState(),
      );

      expect(response.status).toBe(400);
      expect(quoteCreated).toBe(false);
    }
  });

  test("/receive/onchain accepts exact NUT-30 bounds and absent opposite limits", async () => {
    for (const [amount, minAmount, maxAmount] of [
      [21, toAmount(21), null],
      [200, null, toAmount(200)],
    ] as const) {
      let quoteCreated = false;
      const manager = {
        mint: {
          checkPaymentMethodCapability: async () => ({
            supported: true,
            disabled: false,
            operation: "mint",
            nut: 4,
            method: "onchain",
            unit: "sat",
            minAmount,
            maxAmount,
          }),
        },
        quotes: {
          mint: {
            create: async () => {
              quoteCreated = true;
              return { request: "bc1qexample", expiry: null };
            },
          },
        },
      };
      const stateManager = unlockedStateManager(manager);
      const routes = createRouteHandlers(stateManager);

      const response = await routes["/receive/onchain"]!.POST!(
        postJson("/receive/onchain", { amount }),
        stateManager.getState(),
      );

      expect(response.status).toBe(200);
      expect(quoteCreated).toBe(true);
    }
  });

  test("/receive/onchain treats an expiry-zero quote as non-expiring", async () => {
    const manager = {
      mint: {
        checkPaymentMethodCapability: async () => ({
          supported: true,
          disabled: false,
          operation: "mint",
          nut: 4,
          method: "onchain",
          unit: "sat",
        }),
      },
      quotes: {
        mint: {
          create: async () => ({ request: "bc1qexample", expiry: 0 }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/onchain"]!.POST!(
      postJson("/receive/onchain", {}),
      stateManager.getState(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: "bc1qexample" });
  });

  test("/receive/onchain trusts Coco to monitor a future-expiring quote", async () => {
    const manager = {
      mint: {
        checkPaymentMethodCapability: async () => ({
          supported: true,
          disabled: false,
          operation: "mint",
          nut: 4,
          method: "onchain",
          unit: "sat",
        }),
      },
      quotes: {
        mint: {
          create: async () => ({
            request: "bc1qufgy354j3kmvuch987xe4s40836x3h0lg8f5n2",
            expiry: Math.floor(Date.now() / 1000) + 3600,
          }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/onchain"]!.POST!(
      postJson("/receive/onchain", { amount: 21 }),
      stateManager.getState(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      output: "bitcoin:bc1qufgy354j3kmvuch987xe4s40836x3h0lg8f5n2?amount=0.00000021",
    });
  });

  test("/receive/bolt12 treats an expiry-zero quote as non-expiring", async () => {
    const manager = {
      quotes: {
        mint: {
          create: async () => ({ request: "lno1example", expiry: 0 }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/receive/bolt12"]!.POST!(
      postJson("/receive/bolt12", {}),
      stateManager.getState(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: "lno1example" });
  });

  test("/receive/bolt12 accepts null and future expiries but rejects expired quotes", async () => {
    for (const expiry of [null, Math.floor(Date.now() / 1000) + 3600]) {
      const manager = {
        quotes: {
          mint: {
            create: async () => ({ request: "lno1example", expiry }),
          },
        },
      };
      const stateManager = unlockedStateManager(manager);
      const routes = createRouteHandlers(stateManager);

      const response = await routes["/receive/bolt12"]!.POST!(
        postJson("/receive/bolt12", {}),
        stateManager.getState(),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: "lno1example" });
    }

    const manager = {
      quotes: {
        mint: {
          create: async () => ({
            request: "lno1expired",
            expiry: Math.floor(Date.now() / 1000) - 1,
          }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);
    const response = await routes["/receive/bolt12"]!.POST!(
      postJson("/receive/bolt12", {}),
      stateManager.getState(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The mint returned an expired quote" });
  });

  test("/send/onchain rejects bitcoin URIs because send-side BIP-321 parsing is out of scope", async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/onchain"]!.POST!(
      postJson("/send/onchain", {
        address: "bitcoin:bc1qexample?amount=0.00000021",
        amount: 21,
      }),
      stateManager.getState(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Pass a raw Bitcoin address; bitcoin: URI parsing is not supported",
    });
  });

  test("/send/onchain requires a positive safe-integer amount", async () => {
    for (const amount of [undefined, 0, -1, 10.5, Number.MAX_SAFE_INTEGER + 1, null, "21"]) {
      const stateManager = unlockedStateManager();
      const routes = createRouteHandlers(stateManager);
      const response = await routes["/send/onchain"]!.POST!(
        postJson("/send/onchain", { address: "bc1qexample", amount }),
        stateManager.getState(),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Amount must be a positive safe integer",
      });
    }
  });

  test("/send/onchain passes the raw address and amount to Coco", async () => {
    let quoteInput: unknown;
    let prepareInput: unknown;
    const manager = {
      quotes: {
        melt: {
          create: async (input: unknown) => {
            quoteInput = input;
            return {
              fee_options: [
                { fee_index: 0, fee_reserve: toAmount(500), estimated_blocks: 1 },
                { fee_index: 1, fee_reserve: toAmount(120), estimated_blocks: 12 },
                { fee_index: 2, fee_reserve: toAmount(900), estimated_blocks: 0 },
              ],
            };
          },
        },
      },
      ops: {
        melt: {
          prepare: async (input: unknown) => {
            prepareInput = input;
            return { id: "melt-1", state: "prepared" };
          },
          execute: async () => ({ id: "melt-1", state: "pending" }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/onchain"]!.POST!(
      postJson("/send/onchain", {
        address: "  bc1qexample  ",
        amount: 21,
      }),
      stateManager.getState(),
    );

    expect(response.status).toBe(202);
    expect(quoteInput).toEqual({
      mintUrl: "https://mint.example.com",
      method: "onchain",
      methodData: { address: "bc1qexample", amountSats: 21 },
    });
    expect(prepareInput).toMatchObject({ feeIndex: 1 });
    expect(await response.json()).toEqual({
      output: "Payment pending: 21 sats to bc1qexample (fee option 1, operation melt-1)",
    });
  });

  test("/send/onchain reports a finalized operation as sent", async () => {
    const manager = {
      quotes: {
        melt: {
          create: async () => ({
            fee_options: [{ fee_index: 0, fee_reserve: toAmount(2), estimated_blocks: 6 }],
          }),
        },
      },
      ops: {
        melt: {
          prepare: async () => ({ id: "melt-1", state: "prepared" }),
          execute: async () => ({ id: "melt-1", state: "finalized" }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/onchain"]!.POST!(
      postJson("/send/onchain", {
        address: "bc1qexample",
        amount: 21,
      }),
      stateManager.getState(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      output: "Sent 21 sats to bc1qexample (fee option 0)",
    });
  });

  test("/send/bolt12 reports a pending operation without claiming payment", async () => {
    const manager = {
      quotes: {
        melt: {
          create: async () => ({ quoteId: "quote-1" }),
        },
      },
      ops: {
        melt: {
          prepare: async () => ({ id: "melt-1", state: "prepared" }),
          execute: async () => ({ id: "melt-1", state: "pending" }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/bolt12"]!.POST!(
      postJson("/send/bolt12", { offer: "lno1example", amount: 21 }),
      stateManager.getState(),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      output: "Payment pending for offer: lno1example (operation melt-1)",
    });
  });

  test("/send/bolt12 reports payment only after finalization", async () => {
    const manager = {
      quotes: {
        melt: {
          create: async () => ({ quoteId: "quote-1" }),
        },
      },
      ops: {
        melt: {
          prepare: async () => ({ id: "melt-1", state: "prepared" }),
          execute: async () => ({ id: "melt-1", state: "finalized" }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/send/bolt12"]!.POST!(
      postJson("/send/bolt12", { offer: "lno1example", amount: 21 }),
      stateManager.getState(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      output: "Paid offer: lno1example",
    });
  });
});

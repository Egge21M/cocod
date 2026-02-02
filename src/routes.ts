import { getDecodedToken } from "coco-cashu-core";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { nip19 } from "nostr-tools";
import { encryptMnemonic } from "./utils/crypto.js";
import { initializeWallet } from "./utils/wallet.js";
import { CONFIG_FILE, SALT_FILE } from "./utils/config.js";
import type { WalletConfig } from "./utils/config.js";
import type {
  DaemonStateManager,
  LockedState,
  UnlockedState,
  RouteHandler,
} from "./utils/state.js";

export function createRouteHandlers(
  stateManager: DaemonStateManager,
): Record<string, { GET?: RouteHandler; POST?: RouteHandler }> {
  return {
    "/ping": {
      GET: async () => Response.json({ output: "pong" }),
    },
    "/status": {
      GET: async (_req, state) => {
        return Response.json({ output: state.status });
      },
    },
    "/init": {
      POST: stateManager.requireUninitialized(async (req: Request) => {
        try {
          const body = (await req.json()) as {
            mnemonic?: string;
            passphrase?: string;
            mintUrl?: string;
          };

          let mnemonic: string;
          if (body.mnemonic) {
            if (!validateMnemonic(body.mnemonic, wordlist)) {
              return Response.json({ error: "Invalid mnemonic" }, { status: 400 });
            }
            mnemonic = body.mnemonic;
          } else {
            mnemonic = generateMnemonic(wordlist, 256);
          }

          const mintUrl = body.mintUrl || "https://mint.minibits.cash/Bitcoin";
          const encrypted = !!body.passphrase;

          await Bun.write(CONFIG_FILE, "");
          await Bun.file(CONFIG_FILE).delete();

          let config: WalletConfig;

          if (encrypted && body.passphrase) {
            const { ciphertext, salt } = await encryptMnemonic(mnemonic, body.passphrase);

            await Bun.write(SALT_FILE, salt);

            config = {
              version: 1,
              mnemonic: ciphertext,
              encrypted: true,
              mintUrl,
              createdAt: new Date().toISOString(),
            };

            stateManager.setLocked(ciphertext, mintUrl);
          } else {
            config = {
              version: 1,
              mnemonic,
              encrypted: false,
              mintUrl,
              createdAt: new Date().toISOString(),
            };

            const manager = await initializeWallet(config);
            const seed = mnemonicToSeedSync(mnemonic);
            stateManager.setUnlocked(manager, mintUrl, seed);
          }

          await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));

          const output = encrypted
            ? `Initialized (locked). Mnemonic: ${mnemonic}\nIMPORTANT: Write down this mnemonic and keep it safe!`
            : `Initialized. Mnemonic: ${mnemonic}\nIMPORTANT: Write down this mnemonic and keep it safe!`;

          return Response.json({ output });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Init failed: ${message}` }, { status: 500 });
        }
      }),
    },
    "/unlock": {
      POST: stateManager.requireLocked(async (req: Request, state: LockedState) => {
        try {
          const body = (await req.json()) as { passphrase: string };

          if (!body.passphrase) {
            return Response.json({ error: "Passphrase required" }, { status: 400 });
          }

          const salt = await Bun.file(SALT_FILE).text();
          const { decryptMnemonic } = await import("./utils/crypto.js");
          const mnemonic = await decryptMnemonic(state.encryptedMnemonic, body.passphrase, salt);

          const config: WalletConfig = {
            version: 1,
            mnemonic,
            encrypted: false,
            mintUrl: state.mintUrl,
            createdAt: new Date().toISOString(),
          };

          const manager = await initializeWallet(config);
          const seed = mnemonicToSeedSync(mnemonic);

          stateManager.setUnlocked(manager, state.mintUrl, seed);

          return Response.json({ output: "Unlocked" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Unlock failed: ${message}` }, { status: 401 });
        }
      }),
    },
    "/npc/address": {
      GET: stateManager.requireUnlocked(async (_req, state: UnlockedState) => {
        try {
          const info = await state.manager.ext.npc.getInfo();
          if (info.name) {
            return Response.json({ output: `${info.name}@npubx.cash` });
          }
          const npub = nip19.npubEncode(info.pubkey);
          return Response.json({ output: `${npub}@npubx.cash` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to get address: ${message}` }, { status: 500 });
        }
      }),
    },
    "/npc/username": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const { username, confirm } = (await req.json()) as {
            username: string;
            confirm?: boolean;
          };
          if (!username) {
            return Response.json({ error: "Username is required" }, { status: 400 });
          }
          if (confirm) {
            const res = await state.manager.ext.npc.setUsername(username, confirm);
            if (res.success) {
              return Response.json({ output: res });
            } else {
              return Response.json({
                error: `Failed to set username. Required amount: ${res.pr.amount}. Required mints: ${res.pr.mints?.join(",")}`,
              });
            }
          } else {
            const res = await state.manager.ext.npc.setUsername(username);
            if (res.success) {
              return Response.json({ output: res });
            } else if (res.success === false) {
              return Response.json(
                {
                  error: `Payment required to set username: ${res.pr.amount || 0} SATS. Use 'cocod npc username ${username} --confirm' to proceed`,
                },
                { status: 402 },
              );
            } else {
              return Response.json({ error: "Invalid response" });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Username operation failed: ${message}` }, { status: 500 });
        }
      }),
    },

    "/balance": {
      GET: stateManager.requireUnlocked(async (_req, state: UnlockedState) => {
        try {
          const balance = await state.manager.wallet.getBalances();
          const augmentedBalance: Record<string, { [unit: string]: number }> = {};
          Object.keys(balance).forEach((url) => {
            augmentedBalance[url] = { sats: balance[url] || 0 };
          });
          return Response.json({ output: augmentedBalance });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to get balance: ${message}` }, { status: 500 });
        }
      }),
    },
    "/receive/cashu": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { token: string };
          const token = body.token;
          const decoded = getDecodedToken(token);
          await state.manager.wallet.receive(token);
          const total = decoded.proofs.reduce(
            (a: number, c: { amount: number }) => a + c.amount,
            0,
          );
          return Response.json({ output: `Received ${total}` });
        } catch (e) {
          if (e instanceof Error) {
            return Response.json({ error: e.message });
          }
          return Response.json({ error: "Receive failed" });
        }
      }),
    },
    "/receive/bolt11": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { amount: number; mintUrl?: string };
          const mintUrl = body.mintUrl || state.mintUrl;
          const quote = await state.manager.quotes.createMintQuote(mintUrl, body.amount);
          return Response.json({ output: quote.request });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to create invoice: ${message}` }, { status: 500 });
        }
      }),
    },
    "/send/cashu": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { amount: number; mintUrl?: string };
          const mintUrl = body.mintUrl || state.mintUrl;
          const prepared = await state.manager.send.prepareSend(mintUrl, body.amount);
          const result = await state.manager.send.executePreparedSend(prepared.id);
          const token = state.manager.wallet.encodeToken(result.token);
          return Response.json({ output: token });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Send failed: ${message}` }, { status: 500 });
        }
      }),
    },
    "/send/bolt11": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { invoice: string; mintUrl?: string };
          const mintUrl = body.mintUrl || state.mintUrl;
          const prepared = await state.manager.quotes.prepareMeltBolt11(mintUrl, body.invoice);
          await state.manager.quotes.executeMelt(prepared.id);
          return Response.json({ output: `Paid invoice: ${body.invoice}` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Payment failed: ${message}` }, { status: 500 });
        }
      }),
    },
    "/mints/add": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { url: string };
          await state.manager.mint.addMint(body.url, { trusted: true });
          return Response.json({ output: `Added mint: ${body.url}` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to add mint: ${message}` }, { status: 500 });
        }
      }),
    },
    "/mints/list": {
      GET: stateManager.requireUnlocked(async (_req, state: UnlockedState) => {
        try {
          const mints = await state.manager.mint.getAllTrustedMints();
          return Response.json({
            output: mints.map((m) => m.mintUrl).join("\n"),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to list mints: ${message}` }, { status: 500 });
        }
      }),
    },
    "/mints/info": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { url: string };
          const info = await state.manager.mint.getMintInfo(body.url);
          return Response.json({ output: info });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to get mint info: ${message}` }, { status: 500 });
        }
      }),
    },

    "/history": {
      GET: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        const url = new URL(req.url);
        const offsetParam = url.searchParams.get("offset");
        const limitParam = url.searchParams.get("limit");

        const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
        const limit = limitParam ? parseInt(limitParam, 10) : 20;

        if (isNaN(offset) || offset < 0) {
          return Response.json({ error: "Invalid offset parameter" }, { status: 400 });
        }

        if (isNaN(limit) || limit < 1 || limit > 100) {
          return Response.json(
            { error: "Invalid limit parameter (must be 1-100)" },
            { status: 400 },
          );
        }

        const entries = await state.manager.history.getPaginatedHistory(offset, limit);
        return Response.json({ output: entries });
      }),
    },
    "/events": {
      GET: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        const KEEP_ALIVE_INTERVAL = 5000; // 5 seconds (prevent 8-10s idle timeout)

        const stream = new ReadableStream({
          start(controller) {
            // Subscribe to history updates
            const unsubscribe = state.manager.on("history:updated", (payload) => {
              const eventData = JSON.stringify({
                type: "history:updated",
                timestamp: new Date().toISOString(),
                data: payload,
              });
              const sseData = `data: ${eventData}\n\n`;
              controller.enqueue(new TextEncoder().encode(sseData));
            });

            // Send periodic keep-alive pings to prevent connection timeout
            const keepAliveInterval = setInterval(() => {
              controller.enqueue(new TextEncoder().encode(": ping\n\n"));
            }, KEEP_ALIVE_INTERVAL);

            // Cleanup on client disconnect
            req.signal.addEventListener("abort", () => {
              clearInterval(keepAliveInterval);
              unsubscribe();
              controller.close();
            });
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          },
        });
      }),
    },
  };
}

export function buildRoutes(
  routeHandlers: Record<string, { GET?: RouteHandler; POST?: RouteHandler }>,
  getState: () => import("./utils/state.js").DaemonState,
): Record<
  string,
  {
    GET?: (req: Request) => Promise<Response>;
    POST?: (req: Request) => Promise<Response>;
  }
> {
  const routes: Record<
    string,
    {
      GET?: (req: Request) => Promise<Response>;
      POST?: (req: Request) => Promise<Response>;
    }
  > = {};

  for (const [path, handlers] of Object.entries(routeHandlers)) {
    routes[path] = {};

    if (handlers.GET) {
      const handler = handlers.GET;
      routes[path]!.GET = async (req: Request) => handler(req, getState());
    }

    if (handlers.POST) {
      const handler = handlers.POST;
      routes[path]!.POST = async (req: Request) => handler(req, getState());
    }
  }

  return routes;
}

import {
  getEncodedToken,
  normalizeMintUrl,
  resolveOnchainMeltFeeOption,
  type Logger,
  type OnchainMeltQuote,
} from "@cashu/coco-core";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { nip19 } from "nostr-tools";

import { decryptMnemonic, encryptMnemonic } from "./utils/crypto.js";
import { CONFIG_FILE, SALT_FILE } from "./utils/config.js";
import { encodeOnchainPaymentUri } from "./utils/bip321.js";
import { serializeError } from "./utils/logger.js";
import { initializeWallet } from "./utils/wallet.js";
import type { WalletConfig } from "./utils/config.js";
import type { AppLogger } from "./utils/logger.js";
import type {
  DaemonStateManager,
  LockedState,
  UnlockedState,
  RouteHandler,
} from "./utils/state.js";

const UNSUPPORTED_CREQB_ERROR =
  "creqB requests are disabled because the pinned Cashu decoder drops NUT-10 spending conditions";
const UNSUPPORTED_NUT10_ERROR =
  "NUT-10-locked requests cannot be safely prepared by Coco 2.0.0-rc.2's payment-request API";

export function createRouteHandlers(
  stateManager: DaemonStateManager,
  logger?: Logger,
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

          const mintUrl = tryNormalizeMintUrl(body.mintUrl || "https://mint.minibits.cash/Bitcoin");
          if (!mintUrl) {
            return Response.json({ error: "Invalid mint URL" }, { status: 400 });
          }
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

            const { manager, npcAccount } = await initializeWallet(config, undefined, logger);
            const seed = mnemonicToSeedSync(mnemonic);
            stateManager.setUnlocked(manager, mintUrl, seed, npcAccount);
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
          const mnemonic = await decryptMnemonic(state.encryptedMnemonic, body.passphrase, salt);

          const config: WalletConfig = {
            version: 1,
            mnemonic,
            encrypted: false,
            mintUrl: state.mintUrl,
            createdAt: new Date().toISOString(),
          };

          const { manager, npcAccount } = await initializeWallet(config, undefined, logger);
          const seed = mnemonicToSeedSync(mnemonic);

          stateManager.setUnlocked(manager, state.mintUrl, seed, npcAccount);

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
          const info = await state.npcAccount.getInfo();
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
            const res = await state.npcAccount.setUsername(username, confirm);
            if (res.success) {
              return Response.json({ output: res });
            } else {
              return Response.json({
                error: `Failed to set username. Required amount: ${res.pr.amount}. Required mints: ${res.pr.mints?.join(",")}`,
              });
            }
          } else {
            const res = await state.npcAccount.setUsername(username);
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
          const balances = await state.manager.wallet.balances.byMint();
          const augmentedBalance: Record<string, { [unit: string]: number }> = {};
          for (const [url, snapshot] of Object.entries(balances)) {
            // total (spendable + reserved) matches the v1 getBalances() semantics the
            // output contract was pinned against
            augmentedBalance[url] = { sats: snapshot.total.toNumber() };
          }
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
          const preparedOp = await state.manager.ops.receive.prepare({ token });
          await state.manager.ops.receive.execute(preparedOp);
          return Response.json({ output: `Received ${preparedOp.amount.toNumber()}` });
        } catch (error) {
          if (error instanceof Error) {
            return Response.json({ error: error.message });
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
          const quote = await state.manager.quotes.mint.create({
            mintUrl,
            method: "bolt11",
            amount: body.amount,
          });
          await state.manager.ops.mint.prepare({ quote, amount: body.amount });
          return Response.json({ output: quote.request });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to create invoice: ${message}` }, { status: 500 });
        }
      }),
    },
    "/receive/onchain": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = await readJsonObject(req);
          if (!body) {
            return invalidJsonBodyResponse();
          }
          if (body.amount !== undefined && !isPositiveInt(body.amount)) {
            return Response.json(
              { error: "Amount must be a positive safe integer" },
              { status: 400 },
            );
          }
          const mintUrl = resolveMintUrl(body.mintUrl, state.mintUrl);
          if (!mintUrl) {
            return Response.json({ error: "Invalid mint URL" }, { status: 400 });
          }
          if (body.amount !== undefined) {
            const capability = await state.manager.mint.checkPaymentMethodCapability({
              mintUrl,
              operation: "mint",
              method: "onchain",
              unit: "sat",
            });
            if (capability.minAmount?.greaterThan(body.amount)) {
              return Response.json(
                {
                  error: `Amount is below the mint minimum of ${capability.minAmount.toString()} sats`,
                },
                { status: 400 },
              );
            }
            if (capability.maxAmount?.lessThan(body.amount)) {
              return Response.json(
                {
                  error: `Amount exceeds the mint maximum of ${capability.maxAmount.toString()} sats`,
                },
                { status: 400 },
              );
            }
          }
          const quote = await state.manager.quotes.mint.create({ mintUrl, method: "onchain" });
          const quoteError = reusableQuoteError(quote.expiry);
          if (quoteError) {
            return Response.json({ error: quoteError }, { status: 503 });
          }
          const address = quote.request;
          const output =
            body.amount !== undefined
              ? encodeOnchainPaymentUri({ address, amountSats: body.amount })
              : address;
          return Response.json({ output });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json(
            { error: `Failed to create deposit address: ${message}` },
            { status: 500 },
          );
        }
      }),
    },
    "/receive/onchain/list": {
      GET: stateManager.requireUnlocked(async (_req, state: UnlockedState) => {
        try {
          const output = await listReusableReceiveRequests(state, "onchain");
          return Response.json({ output });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json(
            { error: `Failed to list onchain deposit addresses: ${message}` },
            { status: 500 },
          );
        }
      }),
    },
    "/receive/bolt12": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = await readJsonObject(req);
          if (!body) {
            return invalidJsonBodyResponse();
          }
          if (body.amount !== undefined && !isPositiveInt(body.amount)) {
            return Response.json(
              { error: "Amount must be a positive safe integer" },
              { status: 400 },
            );
          }
          if (body.description !== undefined && typeof body.description !== "string") {
            return Response.json({ error: "Description must be a string" }, { status: 400 });
          }
          const mintUrl = resolveMintUrl(body.mintUrl, state.mintUrl);
          if (!mintUrl) {
            return Response.json({ error: "Invalid mint URL" }, { status: 400 });
          }
          const quote = await state.manager.quotes.mint.create({
            mintUrl,
            method: "bolt12",
            ...(body.amount !== undefined ? { amount: body.amount } : {}),
            ...(body.description ? { description: body.description } : {}),
          });
          const quoteError = reusableQuoteError(quote.expiry);
          if (quoteError) {
            return Response.json({ error: quoteError }, { status: 503 });
          }
          return Response.json({ output: quote.request });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to create offer: ${message}` }, { status: 500 });
        }
      }),
    },
    "/receive/bolt12/list": {
      GET: stateManager.requireUnlocked(async (_req, state: UnlockedState) => {
        try {
          const output = await listReusableReceiveRequests(state, "bolt12");
          return Response.json({ output });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json(
            { error: `Failed to list BOLT12 offers: ${message}` },
            { status: 500 },
          );
        }
      }),
    },
    "/send/cashu": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { amount: number; mintUrl?: string };
          const mintUrl = body.mintUrl || state.mintUrl;
          const prepared = await state.manager.ops.send.prepare({ mintUrl, amount: body.amount });
          const result = await state.manager.ops.send.execute(prepared);
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
          const quote = await state.manager.quotes.melt.create({
            mintUrl,
            method: "bolt11",
            methodData: { invoice: body.invoice },
          });
          const prepared = await state.manager.ops.melt.prepare({ quote });
          await state.manager.ops.melt.execute(prepared);
          return Response.json({ output: `Paid invoice: ${body.invoice}` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Payment failed: ${message}` }, { status: 500 });
        }
      }),
    },
    "/send/onchain": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = await readJsonObject(req);
          if (!body) {
            return invalidJsonBodyResponse();
          }
          if (typeof body.address !== "string" || !body.address.trim()) {
            return Response.json({ error: "Address is required" }, { status: 400 });
          }
          const address = body.address.trim();
          if (/^bitcoin:/i.test(address)) {
            return Response.json(
              { error: "Pass a raw Bitcoin address; bitcoin: URI parsing is not supported" },
              { status: 400 },
            );
          }
          if (!isPositiveInt(body.amount)) {
            return Response.json(
              { error: "Amount must be a positive safe integer" },
              { status: 400 },
            );
          }
          if (body.feeIndex !== undefined && !isNonNegativeInt(body.feeIndex)) {
            return Response.json(
              { error: "Fee index must be a non-negative safe integer" },
              { status: 400 },
            );
          }
          const mintUrl = resolveMintUrl(body.mintUrl, state.mintUrl);
          if (!mintUrl) {
            return Response.json({ error: "Invalid mint URL" }, { status: 400 });
          }
          const quote = await state.manager.quotes.melt.create({
            mintUrl,
            method: "onchain",
            methodData: { address, amountSats: body.amount },
          });
          const feeIndex = body.feeIndex ?? cheapestFeeIndex(quote.fee_options);
          let resolvedFeeIndex: number;
          try {
            resolvedFeeIndex = resolveOnchainMeltFeeOption(quote, feeIndex).feeIndex;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Response.json({ error: message }, { status: 400 });
          }
          const prepared = await state.manager.ops.melt.prepare({
            quote,
            feeIndex: resolvedFeeIndex,
          });
          const result = await state.manager.ops.melt.execute(prepared);
          if (result.state === "pending") {
            return Response.json(
              {
                output: `Payment pending: ${body.amount} sats to ${address} (fee option ${resolvedFeeIndex}, operation ${result.id})`,
              },
              { status: 202 },
            );
          }
          return Response.json({
            output: `Sent ${body.amount} sats to ${address} (fee option ${resolvedFeeIndex})`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Payment failed: ${message}` }, { status: 500 });
        }
      }),
    },
    "/send/bolt12": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = await readJsonObject(req);
          if (!body) {
            return invalidJsonBodyResponse();
          }
          if (typeof body.offer !== "string" || !body.offer.trim()) {
            return Response.json({ error: "Offer is required" }, { status: 400 });
          }
          if (body.amount !== undefined && !isPositiveInt(body.amount)) {
            return Response.json(
              { error: "Amount must be a positive safe integer" },
              { status: 400 },
            );
          }
          const mintUrl = resolveMintUrl(body.mintUrl, state.mintUrl);
          if (!mintUrl) {
            return Response.json({ error: "Invalid mint URL" }, { status: 400 });
          }
          const offer = body.offer.trim();
          const quote = await state.manager.quotes.melt.create({
            mintUrl,
            method: "bolt12",
            methodData: {
              offer,
              ...(body.amount ? { amountSats: body.amount } : {}),
            },
          });
          const prepared = await state.manager.ops.melt.prepare({ quote });
          const result = await state.manager.ops.melt.execute(prepared);
          if (result.state === "pending") {
            return Response.json(
              { output: `Payment pending for offer: ${offer} (operation ${result.id})` },
              { status: 202 },
            );
          }
          return Response.json({ output: `Paid offer: ${offer}` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Payment failed: ${message}` }, { status: 500 });
        }
      }),
    },
    "/x-cashu/parse": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const { request } = (await req.json()) as { request?: string };
          if (!request) {
            return Response.json({ error: "Request is required" }, { status: 400 });
          }
          if (request.trim().toLowerCase().startsWith("creqb1")) {
            return Response.json({ error: UNSUPPORTED_CREQB_ERROR }, { status: 400 });
          }

          const parsed = await state.manager.paymentRequests.parse(request);
          if (parsed.paymentRequest.nut10) {
            return Response.json({ error: UNSUPPORTED_NUT10_ERROR }, { status: 400 });
          }
          const mintMsg =
            parsed.allowedMints?.length > 0
              ? `from one of ${parsed.allowedMints.length} mints`
              : "from any mint";
          const matchingMints =
            parsed.payableMints.length > 0 ? parsed.payableMints.join("\n") : "No matching mint!";
          const msg = `Request requires payment of ${parsed.amount?.toNumber() ?? 0} Sats ${mintMsg}.\nMatching mints:\n${matchingMints}`;
          return Response.json({ output: msg });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json(
            { error: `Failed to parse X-Cashu request: ${message}` },
            { status: 500 },
          );
        }
      }),
    },
    "/x-cashu/handle": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = (await req.json()) as { request?: string; mintUrl?: string };
          if (!body.request) {
            return Response.json({ error: "Request is required" }, { status: 400 });
          }
          if (body.request.trim().toLowerCase().startsWith("creqb1")) {
            return Response.json({ error: UNSUPPORTED_CREQB_ERROR }, { status: 400 });
          }

          const mintUrl = tryNormalizeMintUrl(body.mintUrl || state.mintUrl);
          if (!mintUrl) {
            return Response.json({ error: "Invalid mint URL" }, { status: 400 });
          }
          const parsed = await state.manager.paymentRequests.parse(body.request);
          if (parsed.paymentRequest.nut10) {
            return Response.json({ error: UNSUPPORTED_NUT10_ERROR }, { status: 400 });
          }
          if (!parsed.payableMints.includes(mintUrl)) {
            return Response.json(
              {
                error: `Mint ${mintUrl} does not satisfy request (request specifies different mints, or mint balance is insufficient).`,
              },
              { status: 400 },
            );
          }
          if (parsed.transport.type !== "inband") {
            return Response.json(
              {
                error: `Cocod can not handle payment requests that are not inband`,
              },
              { status: 400 },
            );
          }

          const prepared = await state.manager.paymentRequests.prepare(parsed, { mintUrl });

          const res = await state.manager.paymentRequests.execute(prepared);
          if (res.type !== "inband") {
            return Response.json({ error: "Failed to settle X-Cashu request" }, { status: 500 });
          }
          const xCashuHeader = `X-Cashu: ${getEncodedToken(res.token)}`;

          return Response.json({ output: xCashuHeader });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json(
            { error: `Failed to handle X-Cashu request: ${message}` },
            { status: 500 },
          );
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
    "/mints/default": {
      POST: stateManager.requireUnlocked(async (req, state: UnlockedState) => {
        try {
          const body = await readJsonObject(req);
          if (!body) {
            return invalidJsonBodyResponse();
          }
          if (typeof body.url !== "string" || !body.url.trim()) {
            return Response.json({ error: "URL is required" }, { status: 400 });
          }
          const url = tryNormalizeMintUrl(body.url);
          if (!url) {
            return Response.json({ error: "Invalid mint URL" }, { status: 400 });
          }
          await state.manager.mint.addMint(url, { trusted: true });
          const configText = await Bun.file(CONFIG_FILE).text();
          const config = JSON.parse(configText) as WalletConfig;
          config.mintUrl = url;
          await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
          stateManager.setDefaultMint(url);
          return Response.json({ output: `Default mint set: ${url}` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json(
            { error: `Failed to set default mint: ${message}` },
            { status: 500 },
          );
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
  logger?: AppLogger,
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
      routes[path]!.GET = async (req: Request) => runRoute(path, req, getState, handler, logger);
    }

    if (handlers.POST) {
      const handler = handlers.POST;
      routes[path]!.POST = async (req: Request) => runRoute(path, req, getState, handler, logger);
    }
  }

  return routes;
}

async function runRoute(
  path: string,
  req: Request,
  getState: () => import("./utils/state.js").DaemonState,
  handler: RouteHandler,
  logger?: AppLogger,
): Promise<Response> {
  const startedAt = performance.now();
  const reqId = crypto.randomUUID();
  const requestLogger = logger?.child?.({ method: req.method, path, reqId }) ?? logger;

  try {
    const response = await handler(req, getState());
    const durationMs = Math.round(performance.now() - startedAt);
    const level = response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info";

    requestLogger?.log?.(level, "request.completed", {
      durationMs,
      state: getState().status,
      status: response.status,
    });

    return response;
  } catch (error) {
    requestLogger?.error("request.failed", {
      durationMs: Math.round(performance.now() - startedAt),
      error: serializeError(error),
      state: getState().status,
    });

    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function invalidJsonBodyResponse(): Response {
  return Response.json({ error: "Request body must be a JSON object" }, { status: 400 });
}

function tryNormalizeMintUrl(url: string): string | null {
  try {
    return normalizeMintUrl(url);
  } catch {
    return null;
  }
}

function resolveMintUrl(value: unknown, fallback: string): string | null {
  if (value !== undefined && typeof value !== "string") {
    return null;
  }
  return tryNormalizeMintUrl(value ?? fallback);
}

function reusableQuoteError(expiry: number | null): string | null {
  if (expiry !== null && expiry !== 0 && expiry * 1000 <= Date.now()) {
    return "The mint returned an expired quote";
  }
  return null;
}

async function listReusableReceiveRequests(
  state: UnlockedState,
  method: "onchain" | "bolt12",
): Promise<string> {
  const quotes = await state.manager.quotes.mint.listPending({ method });

  return quotes
    .filter(
      (quote) =>
        typeof quote.request === "string" &&
        /^[\x21-\x7e]+$/.test(quote.request) &&
        reusableQuoteError(quote.expiry) === null,
    )
    .map((quote) => quote.request)
    .join("\n");
}

function cheapestFeeIndex(options: OnchainMeltQuote["fee_options"]): number | undefined {
  let cheapest: OnchainMeltQuote["fee_options"][number] | undefined;
  for (const option of options) {
    if (!cheapest || option.fee_reserve.lessThan(cheapest.fee_reserve)) {
      cheapest = option;
    }
  }
  return cheapest?.fee_index;
}

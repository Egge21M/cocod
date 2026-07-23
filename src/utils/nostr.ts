import { SimplePool, getPublicKey, nip19 } from "nostr-tools";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip17";
import type { Event } from "nostr-tools";
import type { Plugin, ServiceMap } from "@cashu/coco-core/plugin";

type TransportHandler = Parameters<
  ServiceMap["paymentRequestReceiveService"]["registerTransportHandler"]
>[0];
type RequestTransport = Awaited<
  ReturnType<NonNullable<TransportHandler["createRequestTransport"]>>
>;

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.8333.space",
];

const GIFT_WRAP_KIND = 1059;
const PUBLISH_TIMEOUT_MS = 15_000;
const RESUBSCRIBE_INTERVAL_MS = 60_000;
// NIP-59 randomizes gift-wrap timestamps up to 2 days into the past
const LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const MAX_SEEN_WRAP_IDS = 10_000;

const pool = new SimplePool();

function getRelays(): string[] {
  const env = process.env.COCOD_RELAYS;
  if (!env) return DEFAULT_RELAYS;
  const relays = env
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return relays.length > 0 ? relays : DEFAULT_RELAYS;
}

export function decodeNostrTarget(target: string): { pubkey: string; relays: string[] } {
  if (/^[0-9a-f]{64}$/i.test(target)) {
    return { pubkey: target.toLowerCase(), relays: [] };
  }
  const decoded = nip19.decode(target);
  if (decoded.type === "nprofile") {
    return { pubkey: decoded.data.pubkey, relays: decoded.data.relays ?? [] };
  }
  if (decoded.type === "npub") {
    return { pubkey: decoded.data, relays: [] };
  }
  throw new Error(`Unsupported nostr target: ${decoded.type}`);
}

export async function sendPaymentDm(
  sk: Uint8Array,
  target: string,
  content: string,
): Promise<void> {
  const { pubkey, relays } = decodeNostrTarget(target);
  const wrap = wrapEvent(sk, { publicKey: pubkey }, content);
  // SimplePool.publish FULFILLS with a "connection failure: ..." string when a relay is
  // unreachable; treat that as a rejection or Promise.any would report success on the
  // fastest-failing relay while no relay accepted the event.
  const publishes = pool.publish([...new Set([...relays, ...getRelays()])], wrap).map((p) =>
    p.then((reason) => {
      if (typeof reason === "string" && reason.startsWith("connection failure")) {
        throw new Error(reason);
      }
      return reason;
    }),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.any(publishes),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out publishing to relays")),
          PUBLISH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof AggregateError) {
      throw new Error("All relays rejected the message");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createNostrTransportPlugin(options: { secretKey: Uint8Array }): Plugin {
  return {
    name: "cocod-nostr-transport",
    required: ["paymentRequestReceiveService", "logger"],
    onInit(ctx) {
      const service = ctx.services.paymentRequestReceiveService;
      const logger = ctx.services.logger;
      const pubkey = getPublicKey(options.secretKey);
      // operation id -> createdAt (ms); the oldest anchors the subscription window so
      // payments gift-wrapped while the daemon was down are still found on restart
      const activeOperations = new Map<string, number>();
      const seenWrapIds = new Set<string>();
      let sub: { close: () => void } | null = null;
      let resubscribeTimer: ReturnType<typeof setInterval> | null = null;

      const handleWrap = async (wrap: Event): Promise<void> => {
        if (seenWrapIds.has(wrap.id)) return;
        seenWrapIds.add(wrap.id);
        if (seenWrapIds.size > MAX_SEEN_WRAP_IDS) {
          // insertion-ordered Set: evict the oldest id; coco's transportMessageId
          // idempotency keeps re-delivery of evicted wraps safe
          const oldest = seenWrapIds.values().next().value;
          if (oldest !== undefined) seenWrapIds.delete(oldest);
        }
        try {
          const rumor = unwrapEvent(wrap, options.secretKey);
          const content = rumor.content;
          if (!content.includes('"proofs"') || !content.includes('"mint"')) return;
          await service.ingestPayload(content, {
            transport: "nostr",
            transportMessageId: wrap.id,
            senderPubkey: rumor.pubkey,
          });
        } catch (error) {
          logger.debug("nostr.ingest_skipped", { error: String(error) });
        }
      };

      const subscribe = (): void => {
        sub?.close();
        const nowSec = Math.floor(Date.now() / 1000);
        const oldestCreatedAtSec = Math.min(
          nowSec,
          ...[...activeOperations.values()].map((ms) => Math.floor(ms / 1000)),
        );
        sub = pool.subscribeMany(
          getRelays(),
          {
            kinds: [GIFT_WRAP_KIND],
            "#p": [pubkey],
            since: oldestCreatedAtSec - LOOKBACK_SECONDS,
          },
          { onevent: (event) => void handleWrap(event) },
        );
      };

      const teardown = (): void => {
        sub?.close();
        sub = null;
        if (resubscribeTimer) {
          clearInterval(resubscribeTimer);
          resubscribeTimer = null;
        }
      };

      const unregister = service.registerTransportHandler({
        type: "nostr",
        createRequestTransport: () => ({
          // cashu-ts types `type` as a string enum whose runtime value is "nostr"; cast the
          // literal instead of taking a direct cashu-ts dependency for one enum member.
          type: "nostr" as RequestTransport["type"],
          target: nip19.nprofileEncode({ pubkey, relays: getRelays().slice(0, 3) }),
          tags: [["n", "17"]],
        }),
        activate: (operation) => {
          activeOperations.set(operation.id, operation.createdAt);
          if (activeOperations.size === 1) {
            subscribe();
            // relay sockets drop silently; periodic re-subscribe is the self-healing backstop
            resubscribeTimer = setInterval(subscribe, RESUBSCRIBE_INTERVAL_MS);
          }
        },
        deactivate: (operation) => {
          activeOperations.delete(operation.id);
          if (activeOperations.size === 0) teardown();
        },
      });

      return () => {
        teardown();
        unregister();
      };
    },
  };
}

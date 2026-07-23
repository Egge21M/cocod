import { initializeCoco, ConsoleLogger, type Logger, type Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NPCPlugin, type NPCAccountApi } from "coco-cashu-plugin-npc";
import { privateKeyFromSeedWords } from "nostr-tools/nip06";
import { finalizeEvent, type EventTemplate } from "nostr-tools";
import { decryptMnemonic } from "./crypto.js";
import { SALT_FILE, DB_FILE } from "./config.js";
import { createNostrTransportPlugin } from "./nostr.js";
import type { WalletConfig } from "./config.js";

export interface InitializedWallet {
  manager: Manager;
  nostrSk: Uint8Array;
  npcAccount: NPCAccountApi;
}

export async function initializeWallet(
  config: WalletConfig,
  passphrase?: string,
  logger?: Logger,
): Promise<InitializedWallet> {
  let mnemonic: string;

  if (config.encrypted) {
    if (!passphrase) {
      throw new Error("Passphrase required for encrypted wallet");
    }
    const salt = await Bun.file(SALT_FILE).text();
    mnemonic = await decryptMnemonic(config.mnemonic, passphrase, salt);
  } else {
    mnemonic = config.mnemonic;
  }

  const seed = mnemonicToSeedSync(mnemonic);

  const repo = new SqliteRepositories({ database: new Database(DB_FILE) });
  const walletLogger = logger?.child?.({ component: "coco" }) ?? logger;
  const cocoLogger = walletLogger ?? new ConsoleLogger("Coco", { level: "info" });
  const sk = privateKeyFromSeedWords(mnemonic);
  const signer = async (t: EventTemplate) => finalizeEvent(t, sk);
  const npcPlugin = new NPCPlugin({
    // npub.cash is a marketing redirect that does not speak the sync protocol
    defaultBaseUrl: "https://npubx.cash",
  });
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
    logger: cocoLogger,
    // Plugins must be registered before init: transport handlers registered later miss
    // the boot-time re-activation of pending payment request receive operations.
    plugins: [npcPlugin, createNostrTransportPlugin({ secretKey: sk })],
  });

  const npcAccount = await npcPlugin.addAccount({
    id: "default",
    signer,
    useWebsocket: true,
    autoStart: true,
  });
  await coco.mint.addMint(config.mintUrl, { trusted: true });

  return { manager: coco, nostrSk: sk, npcAccount };
}

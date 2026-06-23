import { initializeCoco, ConsoleLogger, type Logger, type Manager } from "coco-cashu-core";
import { SqliteRepositories } from "coco-cashu-sqlite-bun";
import { Database } from "bun:sqlite";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NPCPlugin } from "coco-cashu-plugin-npc";
import { privateKeyFromSeedWords } from "nostr-tools/nip06";
import { finalizeEvent, type EventTemplate } from "nostr-tools";
import { decryptMnemonic } from "./crypto.js";
import { SALT_FILE, DB_FILE } from "./config.js";
import type { WalletConfig } from "./config.js";

export async function initializeWallet(
  config: WalletConfig,
  passphrase?: string,
  logger?: Logger,
): Promise<Manager> {
  const walletLogger = logger?.child?.({ component: "wallet-init" }) ?? logger;
  walletLogger?.info?.("wallet.initialize.started", {
    encrypted: config.encrypted,
    mintUrl: config.mintUrl,
    dbFile: DB_FILE,
  });

  let mnemonic: string;

  if (config.encrypted) {
    walletLogger?.info?.("wallet.initialize.decrypting_config_mnemonic", { saltFile: SALT_FILE });
    if (!passphrase) {
      throw new Error("Passphrase required for encrypted wallet");
    }
    const salt = await Bun.file(SALT_FILE).text();
    mnemonic = await decryptMnemonic(config.mnemonic, passphrase, salt);
  } else {
    walletLogger?.info?.("wallet.initialize.using_plaintext_config_mnemonic");
    mnemonic = config.mnemonic;
  }

  walletLogger?.info?.("wallet.initialize.derived_mnemonic");
  const seed = mnemonicToSeedSync(mnemonic);

  walletLogger?.info?.("wallet.initialize.opening_database", { dbFile: DB_FILE });
  const repo = new SqliteRepositories({ database: new Database(DB_FILE) });
  const cocoLogger = walletLogger?.child?.({ component: "coco" }) ?? new ConsoleLogger("Coco", { level: "info" });
  walletLogger?.info?.("wallet.initialize.preparing_signer");
  const sk = privateKeyFromSeedWords(mnemonic);
  const signer = async (t: EventTemplate) => finalizeEvent(t, sk);
  walletLogger?.info?.("wallet.initialize.creating_npc_plugin", { npcUrl: "https://npubx.cash" });
  const npcPlugin = new NPCPlugin("https://npubx.cash", signer, {
    useWebsocket: true,
    logger: cocoLogger,
  });
  walletLogger?.info?.("wallet.initialize.initializing_coco_core", { mintUrl: config.mintUrl });
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
    logger: cocoLogger,
  });

  walletLogger?.info?.("wallet.initialize.registering_npc_plugin");
  coco.use(npcPlugin);

  walletLogger?.info?.("wallet.initialize.adding_trusted_mint", { mintUrl: config.mintUrl });
  await coco.mint.addMint(config.mintUrl, { trusted: true });
  walletLogger?.info?.("wallet.initialize.completed", { mintUrl: config.mintUrl });

  return coco;
}

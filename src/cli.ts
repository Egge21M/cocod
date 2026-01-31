import { startDaemon } from "./daemon";
import { program, handleDaemonCommand, callDaemonStream } from "./cli-shared";

program.name("cocod").description("Coco CLI - A Cashu wallet daemon");

// Status - check daemon/wallet state
program
  .command("status")
  .description("Check daemon and wallet status")
  .action(async () => {
    await handleDaemonCommand("/status");
  });

// Init - initialize wallet
program
  .command("init [mnemonic]")
  .description("Initialize wallet with optional mnemonic (generates one if not provided)")
  .option("--passphrase <passphrase>", "Encrypt wallet with passphrase")
  .option("--mint-url <url>", "Default mint URL (default: https://mint.minibits.cash/Bitcoin)")
  .action(
    async (mnemonic: string | undefined, options: { passphrase?: string; mintUrl?: string }) => {
      await handleDaemonCommand("/init", {
        method: "POST",
        body: {
          mnemonic,
          passphrase: options.passphrase,
          mintUrl: options.mintUrl,
        },
      });
    },
  );

// Unlock - unlock encrypted wallet
program
  .command("unlock <passphrase>")
  .description("Unlock encrypted wallet with passphrase")
  .action(async (passphrase: string) => {
    await handleDaemonCommand("/unlock", {
      method: "POST",
      body: { passphrase },
    });
  });

// Balance - simple GET command
program
  .command("balance")
  .description("Get wallet balance")
  .action(async () => {
    await handleDaemonCommand("/balance");
  });

// Receive - nested subcommands
const receiveCmd = program.command("receive").description("Receive operations");

receiveCmd
  .command("cashu <token>")
  .description("Receive Cashu token")
  .action(async (token: string) => {
    await handleDaemonCommand("/receive/cashu", {
      method: "POST",
      body: { token },
    });
  });

receiveCmd
  .command("bolt11 <amount>")
  .description("Create Lightning invoice to receive tokens")
  .option("--mint-url <url>", "Mint URL to use (defaults to the mint URL configured during init)")
  .action(async (amount: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand("/receive/bolt11", {
      method: "POST",
      body: { amount: parseInt(amount), mintUrl: options.mintUrl },
    });
  });

// Send - nested subcommands
const sendCmd = program.command("send").description("Send operations");

sendCmd
  .command("cashu <amount>")
  .description("Create Cashu token to send")
  .option("--mint-url <url>", "Mint URL to use (defaults to the mint URL configured during init)")
  .action(async (amount: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand("/send/cashu", {
      method: "POST",
      body: { amount: parseInt(amount), mintUrl: options.mintUrl },
    });
  });

sendCmd
  .command("bolt11 <invoice>")
  .description("Pay Lightning invoice")
  .option("--mint-url <url>", "Mint URL to use (defaults to the mint URL configured during init)")
  .action(async (invoice: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand("/send/bolt11", {
      method: "POST",
      body: { invoice, mintUrl: options.mintUrl },
    });
  });

// Ping
program
  .command("ping")
  .description("Test connection to the daemon")
  .action(async () => {
    await handleDaemonCommand("/ping");
  });

// Stop
program
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    await handleDaemonCommand("/stop", { method: "POST" });
  });

// Mints - nested subcommands
const mintsCmd = program.command("mints").description("Mints operations");

mintsCmd
  .command("add <url>")
  .description("Add a mint URL")
  .action(async (url: string) => {
    await handleDaemonCommand("/mints/add", {
      method: "POST",
      body: { url },
    });
  });

mintsCmd
  .command("list")
  .description("List configured mints")
  .action(async () => {
    await handleDaemonCommand("/mints/list");
  });

mintsCmd
  .command("info <url>")
  .description("Get mint info")
  .action(async (url: string) => {
    await handleDaemonCommand("/mints/info", {
      method: "POST",
      body: { url },
    });
  });

// NPC - nested subcommands
const npcCmd = program.command("npc").description("NPC operations");

npcCmd
  .command("address")
  .description("Get NPC user address")
  .action(async () => {
    await handleDaemonCommand("/npc/address");
  });

npcCmd
  .command("username <name>")
  .description("Buy/set NPC username")
  .option("--confirm", "Confirm payment to set username")
  .action(async (name: string, options: { confirm?: boolean }) => {
    await handleDaemonCommand("/npc/username", {
      method: "POST",
      body: {
        username: name,
        confirm: options.confirm,
      },
    });
  });

// History - with pagination and watch options
program
  .command("history")
  .description("Wallet history operations")
  .option("--offset <number>", "Pagination offset (cannot be combined with --watch)", "0")
  .option("--limit <number>", "Number of entries to fetch (1-100, default: 20)", "20")
  .option(
    "--watch",
    "Stream history updates in real-time after fetching (can be combined with --limit)",
  )
  .action(async (options: { offset?: string; limit?: string; watch?: boolean }) => {
    const offset = parseInt(options.offset || "0", 10);
    const limit = parseInt(options.limit || "20", 10);

    // Validate: offset and watch cannot be combined
    if (offset > 0 && options.watch) {
      console.error("Error: --offset cannot be combined with --watch");
      process.exit(1);
    }

    // Validate numbers
    if (isNaN(offset) || offset < 0) {
      console.error("Error: --offset must be a non-negative number");
      process.exit(1);
    }

    if (isNaN(limit) || limit < 1 || limit > 100) {
      console.error("Error: --limit must be between 1 and 100");
      process.exit(1);
    }

    // Fetch paginated history first (pass params as query string, not body)
    const queryParams = new URLSearchParams();
    queryParams.set("offset", offset.toString());
    queryParams.set("limit", limit.toString());
    const path = `/history?${queryParams.toString()}`;

    await handleDaemonCommand(path);

    // If watch is enabled, continue streaming after initial fetch
    if (options.watch) {
      try {
        await callDaemonStream("/events", (data) => {
          console.log(JSON.stringify(data));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exit(1);
      }
    }
  });

// Daemon command - special case, doesn't go through IPC
program
  .command("daemon")
  .description("Start the background daemon")
  .action(async () => {
    await startDaemon();
  });

export function cli(args: string[]) {
  program.parse(args);
}

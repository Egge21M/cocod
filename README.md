# cocod

A Cashu wallet CLI and daemon built with Bun and TypeScript.

## Overview

`cocod` is a [Cashu](https://cashu.space/) e-cash wallet with a client-daemon architecture. It provides a command-line interface for managing Cashu tokens while a background daemon handles all wallet operations, state management, and mint communication.

### Features

- **Wallet Management**: Initialize with BIP39 mnemonics, optional passphrase encryption
- **Token Operations**: Receive Cashu tokens, check balances across mints
- **Lightning Integration**: Create BOLT11 invoices to mint new tokens
- **Nostr Payment Codes**: NPC addresses for receiving payments
- **Transaction History**: View and paginate wallet history
- **Real-time Updates**: SSE endpoint for live event streaming
- **Multi-mint Support**: Add and manage multiple Cashu mints

## Installation

### From npm (recommended)

```bash
bun install --global cocod
```

### From source

```bash
git clone <repository-url>
cd cocod
bun install
```

## Usage

### Quick Start

```bash
# Check daemon status
cocod status

# Initialize wallet (generates mnemonic automatically)
cocod init

# Or initialize with your own mnemonic
cocod init "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

# Unlock encrypted wallet (if passphrase was set)
cocod unlock "your-passphrase"

# Check balance
cocod balance
```

### Available Commands

#### Wallet Operations

| Command               | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `status`              | Check daemon and wallet status                                  |
| `init [mnemonic]`     | Initialize wallet (generates mnemonic if not provided)          |
| `unlock <passphrase>` | Unlock encrypted wallet                                         |
| `balance`             | Get wallet balance across all mints                             |
| `history`             | View wallet history (supports `--offset`, `--limit`, `--watch`) |

**Options:**

| Option               | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `--passphrase <str>` | Encrypt wallet during init                           |
| `--mint-url <url>`   | Set default mint URL (default: minibits) during init |

#### Receive Operations

| Command                   | Description                                |
| ------------------------- | ------------------------------------------ |
| `receive cashu <token>`   | Receive a Cashu token                      |
| `receive bolt11 <amount>` | Create Lightning invoice to receive tokens |

**Options for `receive bolt11`:**

| Option             | Description                                    |
| ------------------ | ---------------------------------------------- |
| `--mint-url <url>` | Override the default mint URL for this invoice |

#### Send Operations

| Command                 | Description                |
| ----------------------- | -------------------------- |
| `send cashu <amount>`   | Create Cashu token to send |
| `send bolt11 <invoice>` | Pay Lightning invoice      |

**Options for `send cashu` and `send bolt11`:**

| Option             | Description                                        |
| ------------------ | -------------------------------------------------- |
| `--mint-url <url>` | Override the default mint URL for this transaction |

#### Mint Management

| Command          | Description           |
| ---------------- | --------------------- |
| `mint add <url>` | Add a new mint URL    |
| `mint list`      | List configured mints |

#### NPC (npub.cash)

| Command               | Description                                   |
| --------------------- | --------------------------------------------- |
| `npc address`         | Get NPC address for receiving payments        |
| `npc username <name>` | Buy/set NPC username (use `--confirm` to pay) |

NPC Lightning Addresses are email-style identifiers (like `name@npubx.cash`) that route payments to your Nostr pubkey. If you have not purchased a username, your address uses your npub instead. Purchasing is a two-step flow: run `cocod npc username <name>` to see the required sats, then re-run with `--confirm` to complete the payment.

Tip: `cocod npc username <name>` returns the required payment first; re-run with `--confirm` to complete the purchase.

#### Daemon Control

| Command  | Description                            |
| -------- | -------------------------------------- |
| `ping`   | Test daemon connectivity               |
| `stop`   | Stop the background daemon             |
| `daemon` | Start the background daemon explicitly |

### Mint URL Configuration

All transactions require a mint URL to interact with a Cashu mint. The default mint URL is set during wallet initialization and stored in the wallet config.

**Default mint URL:** `https://mint.minibits.cash/Bitcoin`

**Override per-transaction:** Most commands support `--mint-url <url>` to override the default for a single transaction:

```bash
# Initialize with a custom default mint
cocod init --mint-url https://mint.example.com/Bitcoin

# Use a different mint for a single transaction
cocod receive bolt11 1000 --mint-url https://another.mint.com

# Send using a specific mint
cocod send cashu 500 --mint-url https://mint.example.com
```

The mint URL override is useful when:

- Testing different mints without changing your default
- Sending/receiving across multiple mints
- Working with specific mint communities

### Examples

```bash
# Add a mint
cocod mint add https://mint.example.com

# Create a Lightning invoice for 1000 sats (uses default mint)
cocod receive bolt11 1000

# Create an invoice using a specific mint for this transaction
cocod receive bolt11 1000 --mint-url https://mint.example.com

# Receive a Cashu token
cocod receive cashu "cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbeyJ..."

# Create a Cashu token to send (uses default mint)
cocod send cashu 1000

# Send from a specific mint
cocod send cashu 1000 --mint-url https://mint.example.com

# Pay a Lightning invoice
cocod send bolt11 "lnbc1000n1..."

# Check NPC username price
cocod npc username myname

# Buy NPC username
cocod npc username myname --confirm

# View last 10 history entries
cocod history --limit 10

# Watch history in real-time
cocod history --watch
```

## Architecture

### Client-Daemon Model

- **CLI** (`src/cli.ts`): Thin client that sends HTTP requests to the daemon via Unix socket
- **Daemon** (`src/daemon.ts`): Background service using `Bun.serve()` that handles all wallet operations

The CLI automatically starts the daemon if it's not already running.

### IPC Communication

Communication happens over a Unix domain socket:

- Default: `~/.cocod/cocod.sock`
- Configurable via `COCOD_SOCKET` environment variable

## Configuration

### Environment Variables

| Variable       | Default               | Description      |
| -------------- | --------------------- | ---------------- |
| `COCOD_SOCKET` | `~/.cocod/cocod.sock` | Unix socket path |
| `COCOD_PID`    | `~/.cocod/cocod.pid`  | PID file path    |

### Files

- **Config**: `~/.cocod/config.json`
- **Database**: `./coco.db` (SQLite, auto-generated)
- **PID file**: Tracks running daemon process

## Development

### Commands

```bash
# Run CLI from source
bun src/index.ts --help

# Run with npm-style script
bun run start -- --help

# Start daemon explicitly
bun run daemon

# Type check
bun run lint
# or
bunx tsc --noEmit

# Build bundle
bun build src/index.ts --outdir dist --target bun
```

### Project Structure

```
src/
├── index.ts          # CLI entrypoint (shebang: #!/usr/bin/env bun)
├── cli.ts            # Commander-based CLI commands
├── cli-shared.ts     # IPC utilities
├── daemon.ts         # Bun.serve() daemon setup
├── routes.ts         # HTTP route handlers
└── utils/
    ├── config.ts     # Config management
    ├── state.ts      # Daemon state machine
    ├── wallet.ts     # Wallet initialization
    └── crypto.ts     # Mnemonic encryption
```

## Dependencies

- **Bun**: Runtime and built-in APIs (`Bun.serve()`, `fetch()`, `bun:sqlite`)
- **Cashu**: `coco-cashu-core`, `coco-cashu-sqlite3`, `coco-cashu-plugin-npc`
- **CLI**: `commander` for argument parsing
- **Crypto**: `@scure/bip39` for mnemonics, `nostr-tools` for NPC

## License

[Add your license here]

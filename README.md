# cocod

`cocod` is a Cashu wallet CLI with a local daemon.

If you like simple tools: run commands in your terminal, and let the daemon handle wallet state in the background.

## What it does

- Initialize and secure a Cashu wallet
- Check balances and transaction history
- Send and receive Cashu tokens (including token delivery to an npub via Nostr DM)
- Send and receive Lightning payments (BOLT11 and BOLT12 offers)
- Send and receive Cashu payment requests (NUT-18) over Nostr, HTTP, or inband
- Send to and receive on onchain Bitcoin addresses (NUT-30)
- Handle HTTP 402 payments with `X-Cashu`
- Manage trusted mints

## Install

```bash
bun install --global cocod
```

Or from source:

```bash
git clone <repository-url>
cd cocod
bun install
```

## Quick start

```bash
# Check daemon status
cocod status

# Create a wallet (auto-generates mnemonic)
cocod init

# If encrypted during init, unlock it
cocod unlock "your-passphrase"

# Check balance
cocod balance
```

## Most common commands

```bash
# Receive
cocod receive cashu "cashuA..."
cocod receive bolt11 1000
cocod receive creq 1000
cocod receive onchain --amount 50000
cocod receive bolt12 --amount 1000

# Send
cocod send cashu 500
cocod send cashu 500 --to "npub1..."
cocod send bolt11 "lnbc..."
cocod send creq "creqA..."
cocod send onchain "bc1q..." 50000
cocod send bolt12 "lno1..." --amount 1000

# Mints
cocod mints add https://mint.example.com/Bitcoin
cocod mints list

# History
cocod history --limit 10
cocod history --watch

# Logs
cocod logs
cocod logs --follow
cocod logs --path
```

## NPC (Lightning Address)

```bash
# Your NPC address
cocod npc address

# Check username price, then confirm purchase
cocod npc username myname
cocod npc username myname --confirm
```

## Nostr payment requests

`receive creq` prints a NUT-18 payment request whose transport is a NIP-17 gift-wrapped
Nostr DM to the wallet's own key. Payments are claimed while the daemon runs; the
subscription re-activates automatically on daemon restart. `send creq` pays a request over
whichever transport it advertises (inband prints the token, HTTP posts it, Nostr delivers a
DM and rolls the send back if no relay accepts it).

Relays default to a small public set; override with a comma-separated `COCOD_RELAYS`
environment variable.

## HTTP 402 / X-Cashu

```bash
# Inspect request from a 402 response
cocod x-cashu parse "<encoded-x-cashu-request>"

# Settle and get header value for retry
cocod x-cashu handle "<encoded-x-cashu-request>"
```

## Upgrading from 0.0.16 or earlier

The wallet database migrates in place on first start. Migrations are one-way; if you want a
rollback path to the previous release, copy `~/.cocod/coco.db` somewhere safe before
upgrading and delete the copy once you're settled.

## How it works

- CLI: `src/cli.ts`
- Daemon: `src/daemon.ts`
- Routes: `src/routes.ts`
- IPC transport: HTTP over UNIX socket

Defaults:

- State directory: `~/.cocod` (or `COCOD_DIR`; config, database, socket, pid, and log all
  live under it — handy for running a second isolated instance)
- Socket: `~/.cocod/cocod.sock` (or `COCOD_SOCKET`)
- PID file: `~/.cocod/cocod.pid` (or `COCOD_PID`)
- Daemon log: `~/.cocod/daemon.log` (or `COCOD_LOG_FILE`)
- Config: `~/.cocod/config.json`
- Database: `~/.cocod/coco.db`

Logging defaults:

- Structured JSON logs are written to `~/.cocod/daemon.log`
- Rotation keeps 5 files at 5 MiB each by default
- Override with `COCOD_LOG_LEVEL`, `COCOD_LOG_MAX_BYTES`, and `COCOD_LOG_MAX_FILES`

Nostr defaults:

- Relays: a small public set, override with `COCOD_RELAYS` (comma-separated `wss://` URLs)

## Development

```bash
# Run CLI from source
bun src/index.ts --help

# Run daemon directly
bun run daemon

# Typecheck
bun run lint

# Tests
bun test
```

## Docs

- [API and command reference](docs/API.md)
- [Machine-readable daemon contract](docs/daemon-api.json)

## License

MIT

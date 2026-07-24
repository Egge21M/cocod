# cocod

`cocod` is a Cashu wallet CLI with a local daemon.

If you like simple tools: run commands in your terminal, and let the daemon handle wallet state in the background.

## What it does

- Initialize and secure a Cashu wallet
- Check balances and transaction history
- Send and receive Cashu tokens
- Send and receive Lightning payments (BOLT11 and BOLT12 offers)
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
cocod receive onchain --amount 50000
cocod receive onchain list
cocod receive bolt12 --amount 1000
cocod receive bolt12 list

# Send
cocod send cashu 500
cocod send bolt11 "lnbc..."
cocod send onchain "bc1q..." 50000
cocod send bolt12 "lno1..." --amount 1000

# Mints
cocod mints add https://mint.example.com/Bitcoin
cocod mints default https://mint.example.com/Bitcoin
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

## HTTP 402 / X-Cashu

```bash
# Inspect request from a 402 response
cocod x-cashu parse "<encoded-x-cashu-request>"

# Settle and get header value for retry
cocod x-cashu handle "<encoded-x-cashu-request>"
```

Cocod accepts `creqA` requests without NUT-10 locks. It disables `creqB` because the pinned
Cashu decoder can discard NUT-10 spending conditions, and it rejects decoded locks because
Coco 2.0.0-rc.2's payment-request API does not enforce them.

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

## BIP-321 scope

- `receive onchain --amount <sats>` generates a BIP-321
  address-and-amount URI. Testnet SegWit addresses use the `tb` query key.
- `receive onchain list` returns saved raw deposit addresses that meet cocod's current expiry
  policy. It reads local Coco state without refreshing it. The optional BIP-321 amount is a
  display hint and is not persisted with the address.
- Coco monitors reusable onchain quotes through their advertised expiry. Cocod rejects quotes
  that are already expired but does not impose a stricter lifetime policy.
- The amount is a payment hint and only eligible confirmed deposits are mintable.
- `send onchain` accepts a raw Bitcoin address and an explicit satoshi amount. It does not
  parse BIP-321 URIs.

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

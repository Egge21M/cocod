# API and Command Reference

This document contains the detailed reference moved out of `README.md`.

## CLI commands

All commands are available under `cocod`.

### Wallet

- `status` - Check daemon and wallet status
- `init [mnemonic]` - Initialize wallet; generates mnemonic if omitted
  - `--passphrase <str>` encrypt wallet at creation time
  - `--mint-url <url>` set default mint URL
- `unlock <passphrase>` - Unlock encrypted wallet
- `balance` - Get wallet balances
- `history` - List history entries
  - `--offset <number>` default `0`
  - `--limit <number>` default `20`, max `100`
  - `--watch` stream real-time updates after initial fetch

### Receive

- `receive cashu <token>` - Receive a Cashu token
- `receive bolt11 <amount>` - Create a Lightning invoice
  - `--mint-url <url>` override default mint for this request
- `receive onchain` - Get an onchain deposit address from the mint (NUT-30)
  - `--amount <sats>` wrap the address and payment hint as a BIP-321 URI; testnet SegWit
    addresses use the `tb` query key
  - `--mint-url <url>` override default mint
  - Only eligible confirmed deposits are mintable
  - The amount must stay within the mint's advertised range because Coco rc.2 auto-claims the
    available balance as one operation
- `receive onchain list` - List saved raw addresses that meet cocod's current expiry policy
  - BIP-321 amount hints are not included because cocod does not persist them with the quote
- `receive bolt12` - Create a BOLT12 offer (NUT-25)
  - `--amount <sats>` embed a fixed amount in the offer (omit for a reusable amountless offer)
  - `--description <text>` description to embed in the offer
  - `--mint-url <url>` override default mint
- `receive bolt12 list` - List saved offers that meet cocod's current expiry policy

`receive onchain` trusts Coco to monitor reusable quotes through their advertised expiry.
The list commands use Coco's persisted reusable quotes without refreshing them and omit
rejected or already-expired requests.

### Send

- `send cashu <amount>` - Create a Cashu token to send
  - `--mint-url <url>` override default mint
- `send bolt11 <invoice>` - Pay a Lightning invoice
  - `--mint-url <url>` override default mint
- `send onchain <address> <amount>` - Pay to an onchain address (NUT-30)
  - `<address>` must be a raw Bitcoin address; BIP-321 URI parsing is not supported
  - `<amount>` is required and expressed in sats
  - `--fee-index <index>` pick a mint fee option (defaults to the cheapest)
  - `--mint-url <url>` override default mint
  - A pending melt returns status 202 with its operation ID; a finalized melt returns 200
- `send bolt12 <offer>` - Pay a BOLT12 offer (NUT-25)
  - `--amount <sats>` required for amountless offers
  - `--mint-url <url>` override default mint

### Mints

- `mints add <url>` - Add mint URL
- `mints default <url>` - Set the default mint (trusts it, persists across restarts, takes
  effect immediately; commands without `--mint-url` use it)
- `mints list` - List configured mints
- `mints info <url>` - Fetch mint metadata

### NPC

- `npc address` - Get your NPC Lightning address
- `npc username <name>` - Begin username purchase flow
  - `--confirm` confirm payment and complete purchase

### X-Cashu / NUT-24

- `x-cashu parse <request>` - Parse an encoded payment request
- `x-cashu handle <request>` - Settle request and return `X-Cashu: cashuB...` header value

Cocod accepts `creqA` requests without NUT-10 locks. It disables `creqB` because the pinned
Cashu decoder can discard NUT-10 spending conditions, and it rejects decoded locks because
Coco 2.0.0-rc.2's payment-request API does not enforce them.

### Daemon control

- `ping` - Check daemon connectivity
- `daemon` - Start daemon in foreground
- `stop` - Stop daemon

## Daemon HTTP endpoints

The CLI talks to the daemon over HTTP on a UNIX socket.

- Socket path env var: `COCOD_SOCKET`
- Default socket: `~/.cocod/cocod.sock`

### Response shape

- Success: `{ "output": <value> }`
- Error: `{ "error": "message" }`

### Endpoint list

- `GET /ping`
- `GET /status`
- `POST /init`
- `POST /unlock`
- `GET /balance`
- `POST /receive/cashu`
- `POST /receive/bolt11`
- `POST /receive/onchain`
- `GET /receive/onchain/list`
- `POST /receive/bolt12`
- `GET /receive/bolt12/list`
- `POST /send/cashu`
- `POST /send/bolt11`
- `POST /send/onchain`
- `POST /send/bolt12`
- `POST /x-cashu/parse`
- `POST /x-cashu/handle`
- `POST /mints/add`
- `POST /mints/default`
- `GET /mints/list`
- `POST /mints/info`
- `GET /history`
- `GET /events` (SSE stream)
- `GET /npc/address`
- `POST /npc/username`
- `POST /stop`

For full request/response and status details, see `docs/daemon-api.json`.

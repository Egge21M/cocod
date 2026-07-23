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
- `receive creq <amount>` - Create a NUT-18 payment request (`creqA...`) paid via Nostr
  - `--description <text>` description to embed in the request
  - `--mint-url <url>` override default mint
  - Incoming payments are claimed while the daemon runs (NIP-17 gift-wrap subscription)
- `receive onchain` - Get an onchain deposit address from the mint (NUT-30)
  - `--amount <sats>` wrap the address as a BIP-321 `bitcoin:` URI (display-only; whatever
    arrives is minted)
  - `--mint-url <url>` override default mint
- `receive bolt12` - Create a BOLT12 offer (NUT-25)
  - `--amount <sats>` embed a fixed amount in the offer (omit for a reusable amountless offer)
  - `--description <text>` description to embed in the offer
  - `--mint-url <url>` override default mint

### Send

- `send cashu <amount>` - Create a Cashu token to send
  - `--mint-url <url>` override default mint
  - `--to <npub>` deliver the token to an npub/nprofile via NIP-17 Nostr DM instead of
    printing it (rolled back if delivery fails)
- `send bolt11 <invoice>` - Pay a Lightning invoice
  - `--mint-url <url>` override default mint
- `send creq <request>` - Pay a NUT-18 payment request (inband, HTTP, or Nostr transport)
  - `--amount <sats>` required when the request has no amount
  - `--mint-url <url>` override default mint
  - Inband requests print the token; Nostr requests are delivered as a NIP-17 DM and rolled
    back on delivery failure. Only `sat` requests are supported.
- `send onchain <address> [amount]` - Pay to an onchain address or `bitcoin:` URI (NUT-30)
  - `[amount]` in sats; may be omitted when the `bitcoin:` URI carries an amount
  - `--fee-index <index>` pick a mint fee option (defaults to the cheapest)
  - `--mint-url <url>` override default mint
  - Onchain melts settle asynchronously; the output reports the fee option and pending state
- `send bolt12 <offer>` - Pay a BOLT12 offer (NUT-25)
  - `--amount <sats>` required for amountless offers
  - `--mint-url <url>` override default mint

### Mints

- `mints add <url>` - Add mint URL
- `mints list` - List configured mints
- `mints info <url>` - Fetch mint metadata

### NPC

- `npc address` - Get your NPC Lightning address
- `npc username <name>` - Begin username purchase flow
  - `--confirm` confirm payment and complete purchase

### X-Cashu / NUT-24

- `x-cashu parse <request>` - Parse an encoded payment request
- `x-cashu handle <request>` - Settle request and return `X-Cashu: cashuB...` header value

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
- `POST /receive/creq`
- `POST /receive/onchain`
- `POST /receive/bolt12`
- `POST /send/cashu`
- `POST /send/bolt11`
- `POST /send/creq`
- `POST /send/onchain`
- `POST /send/bolt12`
- `POST /x-cashu/parse`
- `POST /x-cashu/handle`
- `POST /mints/add`
- `GET /mints/list`
- `POST /mints/info`
- `GET /history`
- `GET /events` (SSE stream)
- `GET /npc/address`
- `POST /npc/username`
- `POST /stop`

For full request/response and status details, see `docs/daemon-api.json`.

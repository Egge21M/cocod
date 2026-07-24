---
name: cocod
description: A Cashu ecash wallet CLI for Bitcoin and Lightning payments. Use when managing Cashu tokens, sending/receiving payments via Lightning (bolt11 and bolt12 offers), using onchain addresses, handling HTTP 402 X-Cashu payment requests, or viewing wallet history.
compatibility: Requires cocod CLI to be installed. Supports Cashu ecash, Lightning Network payments (BOLT11 and BOLT12), onchain payments (NUT-30), receive-side BIP-321 address-and-amount URIs, and creqA NUT-24 HTTP 402 X-Cashu flows without NUT-10 locks.
metadata:
  project: cocod
  type: cashu-wallet
  skill_version: 0.0.16
  requires_cocod_version: 0.0.16
  networks:
    - cashu
    - bitcoin
    - lightning
---

# Cocod - Cashu Wallet CLI

Cocod is a Cashu wallet for managing ecash tokens and making Bitcoin/Lightning payments. It uses the Cashu protocol for privacy-preserving ecash transactions.

If a web/API request returns HTTP `402 Payment Required` with an `X-Cashu` header, use this skill to parse and settle the request with cocod.

## Agent Safety Policy (Required)

When acting as an AGENT with this skill:

- Always ask for explicit user permission before running any command/flow that can spend wallet funds, unless the user has already clearly instructed you to execute that spend action.
- Prefer preview/inspection commands before execution whenever available. For example, run `cocod x-cashu parse <request>` to inspect costs and requirements before `cocod x-cashu handle <request>`.
- Treat `~/.cocod` as sensitive. Never log, print, or expose its contents (including config, mnemonic material, wallet state, sockets, and pid files) unless the user explicitly requests a specific safe subset.
- Always surface issues and errors encountered while using the CLI or this skill. Do not hide failures behind partial success messaging.
- Do not manually work around CLI issues, missing behavior, or unexpected command failures without explicit user permission.

## What is Cashu?

Cashu is a Chaumian ecash protocol that lets you hold and transfer Bitcoin-backed tokens privately. It enables unlinkable transactions using blind signatures.

## Installation

```bash
# Install cocod CLI
bun install -g cocod
```

## Version Compatibility

This skill is version-pinned to an exact `cocod` CLI release.

- `metadata.skill_version` must match the npm package version.
- `metadata.requires_cocod_version` is pinned to that exact same version.

Check your installed CLI version:

```bash
cocod --version
```

If the version does not match the pinned values in this file, update `cocod` before using this skill.

## Quick Start

```bash
# Initialize your wallet (generates mnemonic automatically)
cocod init

# Or with a custom mint
cocod init --mint-url https://mint.example.com

# Check balance
cocod balance
```

## Commands

### Core Wallet

```bash
# Check daemon and wallet status
cocod status

# Initialize wallet with optional mnemonic
cocod init [mnemonic] [--passphrase <passphrase>] [--mint-url <url>]

# Unlock encrypted wallet (only required when initialised with passphrase)
cocod unlock <passphrase>

# Get wallet balance
cocod balance

# Test daemon connection
cocod ping
```

### Receiving Payments

```bash
# Receive Cashu token
cocod receive cashu <token>

# Create Lightning invoice to receive
cocod receive bolt11 <amount> [--mint-url <url>]

# Get an onchain deposit address from the mint (NUT-30)
# --amount is a BIP-321 payment hint; only eligible confirmed deposits are mintable.
cocod receive onchain [--amount <sats>] [--mint-url <url>]

# List saved raw addresses that Coco still considers pending and that have not expired.
# BIP-321 amount hints are not persisted with the address.
cocod receive onchain list

# Create a BOLT12 offer (NUT-25); omit --amount for a reusable amountless offer
cocod receive bolt12 [--amount <sats>] [--description <text>] [--mint-url <url>]

# List saved BOLT12 offers that are non-expiring or have not yet expired
cocod receive bolt12 list
```

### Sending Payments

AGENT rule: commands in this section spend wallet funds. Ask for permission first unless the user already explicitly requested the spend action.

```bash
# Create Cashu token to send to someone
cocod send cashu <amount> [--mint-url <url>]

# Pay a Lightning invoice
cocod send bolt11 <invoice> [--mint-url <url>]

# Pay to a raw onchain Bitcoin address (NUT-30); amount is required in sats
# Fee defaults to the mint's cheapest option; onchain melts settle asynchronously.
cocod send onchain <address> <amount> [--fee-index <index>] [--mint-url <url>]

# Pay a BOLT12 offer (NUT-25); --amount is required for amountless offers
cocod send bolt12 <offer> [--amount <sats>] [--mint-url <url>]
```

### HTTP 402 Web Payments (NUT-24)

Use these commands when a server responds with HTTP `402` and an `X-Cashu` payment request.

AGENT rule: `cocod x-cashu handle <request>` can spend funds. Prefer `cocod x-cashu parse <request>` first to preview amount/requirements, then ask permission before handling unless already instructed.

Compatibility: cocod disables `creqB` because the pinned Cashu decoder can discard NUT-10
spending conditions. It also rejects decoded locks because Coco 2.0.0-rc.2's payment-request
API does not enforce them. Do not work around those guards.

```bash
# Parse an encoded X-Cashu request from a 402 response header
cocod x-cashu parse <request>

# Settle the request and get an X-Cashu payment header value
cocod x-cashu handle <request>
```

Typical flow:

1. Read `X-Cashu` from the `402` response.
2. Run `cocod x-cashu parse <request>` to inspect amount and mint requirements.
3. Run `cocod x-cashu handle <request>` to generate payment token header value.
4. Retry the original web request with returned `X-Cashu: cashuB...` header.

### Mints

```bash
# Add a mint URL
cocod mints add <url>

# Set the default mint (used by commands without --mint-url; persists across restarts)
cocod mints default <url>

# List configured mints
cocod mints list

# Get mint information
cocod mints info <url>
```

### Lightning Address (NPC)

Lightning Addresses are email-style identifiers (like `name@npubx.cash`) that let others pay you over Lightning. If you have not purchased a username, NPC provides a free address from your Nostr npub; purchasing a username gives you a human-readable handle. Buying a username is a two-step flow so you can review the required sats before confirming payment.

AGENT rule: `cocod npc username <name> --confirm` is a spend action. Ask permission before running `--confirm` unless already instructed.

```bash
# Get your NPC Lightning Address
cocod npc address

# Reserve/buy an NPC username (two-step)
cocod npc username <name>
cocod npc username <name> --confirm
```

### History

```bash
# View wallet history
cocod history

# With pagination
cocod history --offset 0 --limit 20

# Watch for real-time updates
cocod history --watch

# Limit with watch
cocod history --limit 50 --watch
```

### Daemon Control

```bash
# Start the background daemon (started automatically when not running when required)
cocod daemon

# Stop the daemon
cocod stop
```

## Examples

**Initialize with encryption:**

```bash
cocod init --passphrase "my-secret"
```

**Receive via Lightning:**

```bash
cocod receive bolt11 5000
# Returns: lnbc50u1... (share this invoice to receive)
```

**Pay a Lightning invoice:**

```bash
cocod send bolt11 lnbc100u1p3w7j3...
```

**Send Cashu to a friend:**

```bash
cocod send cashu 1000
# Returns: cashuAeyJ0b2tlbiI6...
# Friend receives with: cocod receive cashu cashuAeyJ0b2tlbiI6...
```

**Check status and balance:**

```bash
cocod status
cocod balance
```

**View recent history:**

```bash
cocod history --limit 10
```

## Concepts

- **Cashu**: Privacy-preserving ecash protocol using blind signatures
- **Mint**: Server that issues and redeems Cashu tokens
- **Token**: Transferable Cashu string representing satoshi value
- **Bolt11**: Lightning Network invoice format
- **Bolt12**: Lightning offer format (`lno1...`); offers can be amountless and reusable
- **Onchain**: NUT-30 mint deposits/withdrawals using regular Bitcoin addresses
- **NPC**: Lightning Address service for receiving payments
- **Mnemonic**: Seed phrase for wallet recovery

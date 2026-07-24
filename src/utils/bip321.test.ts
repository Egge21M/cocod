import { describe, expect, test } from "bun:test";

import { encodeOnchainPaymentUri } from "./bip321";

describe("encodeOnchainPaymentUri", () => {
  test("encodes integer sats as decimal BTC without exponent notation", () => {
    const address = "bc1qufgy354j3kmvuch987xe4s40836x3h0lg8f5n2";

    expect(encodeOnchainPaymentUri({ address, amountSats: 1 })).toBe(
      `bitcoin:${address}?amount=0.00000001`,
    );
    expect(encodeOnchainPaymentUri({ address, amountSats: 21 })).toBe(
      `bitcoin:${address}?amount=0.00000021`,
    );
    expect(encodeOnchainPaymentUri({ address, amountSats: 100_000_000 })).toBe(
      `bitcoin:${address}?amount=1`,
    );
    expect(encodeOnchainPaymentUri({ address, amountSats: 150_000_000 })).toBe(
      `bitcoin:${address}?amount=1.5`,
    );
  });

  test("uses the BIP-321 testnet payment-instruction key", () => {
    const address = "tb1qghfhmd4zh7ncpmxl3qzhmq566jk8ckq4gafnmg";

    expect(encodeOnchainPaymentUri({ address, amountSats: 21 })).toBe(
      `bitcoin:?tb=${address}&amount=0.00000021`,
    );
  });

  test("keeps a regtest address in the ordinary address path", () => {
    const address = "bcrt1qxlvaw9k0v4m4u6sz5s4z7qjv3f4x0n8xk5m9z2";

    expect(encodeOnchainPaymentUri({ address, amountSats: 21 })).toBe(
      `bitcoin:${address}?amount=0.00000021`,
    );
  });

  test("rejects amounts that cannot be represented exactly as integer sats", () => {
    expect(() =>
      encodeOnchainPaymentUri({
        address: "bc1qufgy354j3kmvuch987xe4s40836x3h0lg8f5n2",
        amountSats: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("positive safe integer");
    expect(() =>
      encodeOnchainPaymentUri({
        address: "bc1qufgy354j3kmvuch987xe4s40836x3h0lg8f5n2",
        amountSats: 1.5,
      }),
    ).toThrow("positive safe integer");
  });
});

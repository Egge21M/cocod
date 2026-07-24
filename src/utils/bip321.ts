const SATS_PER_BTC = 100_000_000;

export interface EncodeOnchainPaymentUriInput {
  address: string;
  amountSats: number;
}

/**
 * Encodes the receive-side address + amount subset used by cocod.
 *
 * The address is the NUT-30 quote request returned by the mint; this helper
 * only formats that upstream protocol value.
 *
 * This intentionally does not parse payment URIs or implement other BIP-321
 * payment instructions.
 */
export function encodeOnchainPaymentUri({
  address,
  amountSats,
}: EncodeOnchainPaymentUriInput): string {
  if (!address) {
    throw new Error("Bitcoin address is required");
  }
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("Amount must be a positive safe integer");
  }

  const wholeBtc = Math.floor(amountSats / SATS_PER_BTC);
  const fractionalSats = amountSats % SATS_PER_BTC;
  const amount =
    fractionalSats === 0
      ? String(wholeBtc)
      : `${wholeBtc}.${String(fractionalSats).padStart(8, "0").replace(/0+$/, "")}`;

  const lowercaseAddress = address.toLowerCase();
  if (lowercaseAddress.startsWith("tb1")) {
    return `bitcoin:?tb=${address}&amount=${amount}`;
  }

  return `bitcoin:${address}?amount=${amount}`;
}

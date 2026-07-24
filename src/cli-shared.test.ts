import { describe, expect, test } from "bun:test";

import { parseNonNegativeIntegerArgument, parsePositiveIntegerArgument } from "./cli-shared";

describe("CLI integer parsing", () => {
  test("accepts exact decimal integers", () => {
    expect(parsePositiveIntegerArgument("21")).toBe(21);
    expect(parseNonNegativeIntegerArgument("0")).toBe(0);
  });

  test("rejects truncated, fractional, exponential, signed, and unsafe inputs", () => {
    for (const value of ["21sats", "1.5", "1e3", "+21", "-1", "9007199254740992"]) {
      expect(() => parsePositiveIntegerArgument(value)).toThrow();
    }
    expect(() => parseNonNegativeIntegerArgument("-1")).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import {
  parseNonNegativeIntegerArgument,
  parsePositiveIntegerArgument,
  rejectParentOptionsForSubcommand,
} from "./cli-shared";

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

describe("CLI nested command options", () => {
  test("rejects parent creation options before or after a list subcommand", async () => {
    for (const args of [
      ["--amount", "21", "list"],
      ["list", "--amount", "21"],
    ]) {
      const parent = new Command("onchain").option("--amount <amount>");
      const list = parent
        .command("list")
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .action(function () {
          rejectParentOptionsForSubcommand(this);
        });

      await expect(parent.parseAsync(args, { from: "user" })).rejects.toThrow(
        "option '--amount <amount>' cannot be used with 'list'",
      );
      expect(list.parent).toBe(parent);
    }
  });
});

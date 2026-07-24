import { InvalidArgumentError, program, type Command } from "commander";

import { SOCKET_PATH } from "./utils/config.js";

export interface CommandResponse {
  output?: unknown;
  error?: string;
}

export function parsePositiveIntegerArgument(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("Integer exceeds JavaScript's safe range");
  }
  return parsed;
}

export function parseNonNegativeIntegerArgument(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("Integer exceeds JavaScript's safe range");
  }
  return parsed;
}

export function rejectParentOptionsForSubcommand(command: Command): void {
  const parent = command.parent;
  const suppliedOption = parent?.options.find(
    (option) => parent.getOptionValueSource(option.attributeName()) === "cli",
  );

  if (suppliedOption) {
    command.error(
      `error: option '${suppliedOption.flags}' cannot be used with '${command.name()}'`,
      {
        exitCode: 1,
        code: "commander.conflictingOption",
      },
    );
  }
}

async function callDaemon(
  path: string,
  options: { method?: "GET" | "POST"; body?: object } = {},
): Promise<CommandResponse> {
  const { method = "GET", body } = options;

  const init: RequestInit & { unix: string } = {
    unix: SOCKET_PATH,
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  } as RequestInit & { unix: string };

  const response = await fetch(`http://localhost${path}`, init);

  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<CommandResponse>;
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost/ping`, {
      unix: SOCKET_PATH,
    } as RequestInit);
    return response.ok;
  } catch {
    return false;
  }
}

export async function startDaemonProcess(): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/index.ts`, "daemon"],
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();

  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await isDaemonRunning()) {
      return;
    }
  }

  throw new Error("Daemon failed to start within 5 seconds");
}

export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) {
    return;
  }

  console.log("Starting daemon...");
  await startDaemonProcess();
}

export async function handleDaemonCommand(
  path: string,
  options: { method?: "GET" | "POST"; body?: object } = {},
): Promise<CommandResponse> {
  try {
    await ensureDaemonRunning();
    const result = await callDaemon(path, options);

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (result.output !== undefined) {
      if (typeof result.output === "string") {
        console.log(result.output);
      } else {
        try {
          const formatted = JSON.stringify(result.output, null, 2);
          console.log(formatted ?? String(result.output));
        } catch {
          console.log(String(result.output));
        }
      }
    }

    return result;
  } catch (error) {
    const message = (error as Error).message;
    if (message?.includes("fetch failed") || message?.includes("Connection refused")) {
      console.error("Daemon is not running and failed to auto-start");
      process.exit(1);
    }
    console.error(message);
    process.exit(1);
  }
}

export async function callDaemonStream(
  path: string,
  onData: (data: unknown) => void,
): Promise<void> {
  await ensureDaemonRunning();

  const init: RequestInit & { unix: string } = {
    unix: SOCKET_PATH,
    method: "GET",
  } as RequestInit & { unix: string };

  const response = await fetch(`http://localhost${path}`, init);

  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            onData(data);
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export { program, callDaemon };

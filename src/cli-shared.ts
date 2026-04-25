import { program } from "commander";

const CONFIG_DIR = `${process.env.HOME || process.env.USERPROFILE}/.cocod`;
const SOCKET_PATH = process.env.COCOD_SOCKET || `${CONFIG_DIR}/cocod.sock`;

export interface CommandResponse {
  output?: unknown;
  error?: string;
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

const DAEMON_POLL_INTERVAL_MS = 1_000;
const DAEMON_SLOW_START_WARNING_MS = 30_000;
const DAEMON_START_LOG_LINES = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDaemonReady(startedAt: number, warningShown: { value: boolean }): Promise<void> {
  for (;;) {
    try {
      const result = await callDaemon("/status");
      if (typeof result.output === "string") {
        return;
      }
    } catch {
      // Daemon may not be accepting requests yet
    }

    if (!warningShown.value && Date.now() - startedAt >= DAEMON_SLOW_START_WARNING_MS) {
      warningShown.value = true;
      console.log("Daemon is taking longer than expected, please wait...");
    }

    await sleep(DAEMON_POLL_INTERVAL_MS);
  }
}

function printProgressStep(message: string): void {
  console.log(`• ${message}`);
}

function maybePrintFriendlyProgress(path: string, body?: object): void {
  if (path === "/init") {
    const mintUrl =
      body && "mintUrl" in body && typeof body.mintUrl === "string"
        ? body.mintUrl
        : "https://mint.minibits.cash/Bitcoin";

    printProgressStep("Preparing wallet...");
    printProgressStep(`Connecting to mint: ${mintUrl}`);
    printProgressStep("This can take a few seconds on first run.");
    return;
  }

  if (path === "/unlock") {
    printProgressStep("Unlocking wallet...");
    printProgressStep("Reconnecting wallet services...");
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

  const startedAt = Date.now();
  const warningShown = { value: false };

  for (;;) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    if (await isDaemonRunning()) {
      await waitForDaemonReady(startedAt, warningShown);
      return;
    }

    if (!warningShown.value && Date.now() - startedAt >= DAEMON_SLOW_START_WARNING_MS) {
      warningShown.value = true;
      console.log("Daemon is taking longer than expected, please wait...");
      console.log(`Tip: run 'cocod logs --follow' or 'tail -n ${DAEMON_START_LOG_LINES} ~/.cocod/daemon.log' in another terminal.`);
    }
  }
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
    maybePrintFriendlyProgress(path, options.body);
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

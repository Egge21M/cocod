import { mnemonicToSeedSync } from "@scure/bip39";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import process from "node:process";
import { CONFIG_DIR, CONFIG_FILE, SOCKET_PATH, PID_FILE } from "./utils/config.js";
import { createDaemonLogger, serializeError } from "./utils/logger.js";
import { DaemonStateManager } from "./utils/state.js";
import { initializeWallet } from "./utils/wallet.js";
import { createRouteHandlers, buildRoutes } from "./routes.js";
import type { WalletConfig } from "./utils/config.js";

async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquirePidLock(logger: ReturnType<typeof createDaemonLogger>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });

  const pidFile = Bun.file(PID_FILE);
  if (await pidFile.exists()) {
    const existingPidText = (await pidFile.text()).trim();
    const existingPid = Number.parseInt(existingPidText, 10);

    if (await isProcessAlive(existingPid)) {
      logger.warn("daemon.start.skipped", {
        reason: "already_running",
        pid: existingPid,
        pidFile: PID_FILE,
      });
      await logger.flush();
      console.error(`Error: Daemon is already running with PID ${existingPid}`);
      process.exit(1);
    }

    logger.warn("daemon.pid.stale", {
      pid: existingPidText || null,
      pidFile: PID_FILE,
    });
    try {
      await unlink(PID_FILE);
    } catch {
      // File may already be gone
    }
  }

  try {
    const fd = openSync(PID_FILE, "wx");
    try {
      writeFileSync(fd, `${process.pid}`);
    } finally {
      closeSync(fd);
    }
  } catch {
    const currentPidText = (await Bun.file(PID_FILE).text()).trim();
    const currentPid = Number.parseInt(currentPidText, 10);

    logger.warn("daemon.start.skipped", {
      reason: "pid_lock_exists",
      pid: Number.isNaN(currentPid) ? currentPidText : currentPid,
      pidFile: PID_FILE,
    });
    await logger.flush();
    console.error("Error: Daemon is already starting or running");
    process.exit(1);
  }
}

export async function startDaemon() {
  const stateManager = new DaemonStateManager();
  const logger = createDaemonLogger({ mirrorToConsole: false });

  logger.info("daemon.start.requested", {
    pidFile: PID_FILE,
    socketPath: SOCKET_PATH,
  });

  await acquirePidLock(logger);

  try {
    const testConn = await Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        data() {},
        open() {},
        close() {},
        drain() {},
      },
    });
    testConn.end();
    logger.warn("daemon.start.skipped", {
      reason: "already_running",
      socketPath: SOCKET_PATH,
    });
    try {
      await unlink(PID_FILE);
    } catch {
      // File might not exist
    }
    await logger.flush();
    console.error(`Error: Daemon is already running on ${SOCKET_PATH}`);
    process.exit(1);
  } catch {
    // Not running, safe to proceed
  }

  try {
    await unlink(SOCKET_PATH);
  } catch {
    // File might not exist
  }

  try {
    const configExists = await Bun.file(CONFIG_FILE).exists();
    if (configExists) {
      const configText = await Bun.file(CONFIG_FILE).text();
      const config: WalletConfig = JSON.parse(configText);

      if (config.encrypted) {
        stateManager.setLocked(config.mnemonic, config.mintUrl);
        logger.info("wallet.config_loaded", {
          encrypted: true,
          mintUrl: config.mintUrl,
          state: "LOCKED",
        });
      } else {
        const manager = await initializeWallet(
          config,
          undefined,
          logger.child({ component: "wallet" }),
        );
        const seed = mnemonicToSeedSync(config.mnemonic);
        stateManager.setUnlocked(manager, config.mintUrl, seed);
        logger.info("wallet.config_loaded", {
          encrypted: false,
          mintUrl: config.mintUrl,
          state: "UNLOCKED",
        });
      }
    } else {
      logger.info("wallet.config_missing");
      logger.info("wallet.uninitialized");
    }
  } catch (error) {
    logger.warn("wallet.config_load_failed", { error: serializeError(error) });
    stateManager.setError(String(error));
  }

  const routeHandlers = createRouteHandlers(stateManager, logger.child({ component: "wallet" }));
  const routes = buildRoutes(
    routeHandlers,
    () => stateManager.getState(),
    logger.child({
      component: "http",
    }),
  );

  let server: ReturnType<typeof Bun.serve> | undefined;
  let isShuttingDown = false;

  const cleanup = async (reason: string) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info("daemon.shutdown.requested", { reason });

    server?.stop();

    try {
      await unlink(PID_FILE);
    } catch {
      // File might not exist
    }

    logger.info("daemon.shutdown.completed", { reason });
    await logger.flush();
    process.exit(0);
  };

  server = Bun.serve({
    unix: SOCKET_PATH,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // Stop endpoint (special daemon control)
      if (path === "/stop" && method === "POST") {
        logger.info("daemon.stop_requested", { reason: "http_stop" });
        setTimeout(() => {
          void cleanup("http_stop");
        }, 100);
        return Response.json({ output: "Daemon stopping" });
      }

      // Look up route in the built routes table
      const route = routes[path];
      if (route) {
        const handler = method === "GET" ? route.GET : method === "POST" ? route.POST : undefined;
        if (handler) {
          return handler(req);
        }
      }

      logger.warn("request.unknown_endpoint", {
        method,
        url: req.url,
      });
      return Response.json({ error: `Unknown endpoint: ${method} ${path}` }, { status: 404 });
    },
  });

  logger.info("daemon.started", { socketPath: SOCKET_PATH });

  process.on("unhandledRejection", (error) => {
    logger.error("daemon.unhandled_rejection", { error: serializeError(error) });
  });

  process.on("uncaughtException", (error) => {
    logger.error("daemon.uncaught_exception", { error: serializeError(error) });
    void logger.flush().finally(() => {
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    void cleanup("sigint");
  });
  process.on("SIGTERM", () => {
    void cleanup("sigterm");
  });
}

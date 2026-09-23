import { Command } from "commander";
import { connect } from "node:net";
import { join, dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import { JsonRpc } from "./jsonrpc.js";
import { Daemon } from "./daemon.js";
import { HyperHttpProxy } from "./proxy.js";
import { installService, uninstallService } from "./service.js";

import Hyperdht from "hyperdht";
import xdg from "xdg-portable";

/** @type {import("xdg-portable").XDG} */
// @ts-ignore default export is callable at runtime but types differ
const xdgInstance = xdg;

function defaultSocketPath() {
  const baseDir = join(xdgInstance.state(), "setkamost");
  return join(baseDir, "sock");
}

/**
 * @returns {Command}
 */
export function createProgram() {
  const prog = new Command();
  prog
    .name("setkamost")
    .description("Expose your HTTP services over peer to peer connections")
    .option(
      "--socket <path>",
      "Socket path",
      process.env.SETKAMOST_SOCKET || defaultSocketPath(),
    );

  const daemon = prog
    .command("daemon")
    .description("Manage the daemon process");

  daemon
    .command("start")
    .description("Start the daemon")
    .action(async (opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);
      await mkdir(dirname(socketPath), { recursive: true });
      const dht = new Hyperdht();
      const proxy = new HyperHttpProxy({ dht });
      const storagePath = join(xdgInstance.data(), "setkamost");
      const d = new Daemon({ proxy, socketPath, storagePath });
      await d.start();
      console.log(`Daemon started (socket: ${socketPath})`);

      const shutdown = async () => {
        await d.stop();
        await proxy.destroy();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async (opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);
      const { existsSync, readFileSync } = await import("node:fs");
      const pidPath = socketPath + ".pid";

      if (!existsSync(pidPath)) {
        console.error("No PID file found. Daemon may not be running.");
        process.exit(1);
      }

      const pid = Number(readFileSync(pidPath, "utf8"));
      try {
        process.kill(pid, "SIGTERM");
        console.log(`Sent SIGTERM to daemon (PID ${pid})`);
      } catch {
        console.error(`Failed to stop daemon (PID ${pid})`);
        process.exit(1);
      }
    });

  daemon
    .command("install")
    .description("Install as a systemd user service")
    .option("--no-start", "Install without starting the service")
    .action(async (opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);
      try {
        const { unitPath, started } = await installService({
          socketPath,
          start: opts.start,
        });
        console.log(`Installed unit file at ${unitPath}`);
        console.log("Service enabled.");
        if (started) {
          console.log("Service started.");
        }
      } catch (err) {
        const msg = /** @type {Error} */ (err).message;
        console.error(`Failed to install service: ${msg}`);
        process.exit(1);
      }
    });

  daemon
    .command("uninstall")
    .description("Remove the systemd user service")
    .action(async () => {
      const { removed } = await uninstallService();
      if (removed) {
        console.log("Service removed.");
      } else {
        console.log("No service found to remove.");
      }
    });

  daemon
    .command("status")
    .description("Check if the daemon is running")
    .action(async (opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);

      try {
        const client = await connectRpc(socketPath);
        client.destroy();
        console.log(`running (socket: ${socketPath})`);
      } catch {
        // Socket not reachable — check for stale PID
        const { existsSync, readFileSync } = await import("node:fs");
        const pidPath = socketPath + ".pid";
        if (existsSync(pidPath)) {
          const pid = Number(readFileSync(pidPath, "utf8"));
          try {
            process.kill(pid, 0);
            console.log(
              `stale (PID ${pid} exists but socket is not responding)`,
            );
            process.exit(1);
          } catch {
            console.log(
              `stale PID file (PID ${pid} not running), socket: ${socketPath}`,
            );
            process.exit(1);
          }
        } else {
          console.log("not running");
          process.exit(1);
        }
      }
    });

  prog
    .command("list")
    .description("List all exposed services")
    .action(async (opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);
      const client = await connectRpc(socketPath);
      try {
        const state = await client.call("list");
        console.log(JSON.stringify(state, null, 2));
      } finally {
        client.destroy();
      }
    });

  prog
    .command("expose-local")
    .description("Expose a local HTTP port")
    .argument("<port>", "Port number to expose")
    .action(async (port, opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);
      const client = await connectRpc(socketPath);
      try {
        const url = await client.call("exposeLocalPort", [Number(port)]);
        console.log(url);
      } finally {
        client.destroy();
      }
    });

  prog
    .command("expose-remote")
    .description("Expose a remote service as local")
    .argument("<url>", "Remote HyperDHT URL")
    .option("--port <number>", "Local port (optional, auto-assigned)")
    .action(async (url, opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);
      const client = await connectRpc(socketPath);
      try {
        const localPort = opts.port ? Number(opts.port) : 0;
        const port = await client.call("exposeRemoteAsLocal", [url, localPort]);
        console.log(port);
      } finally {
        client.destroy();
      }
    });

  prog
    .command("expose-folder")
    .description("Expose a folder as a file server")
    .argument("<path>", "Path to the folder")
    .action(async (path, opts, cmd) => {
      const socketPath = /** @type {string} */ (cmd.optsWithGlobals().socket);
      const client = await connectRpc(socketPath);
      try {
        const url = await client.call("exposeFolder", [resolve(path)]);
        console.log(url);
      } finally {
        client.destroy();
      }
    });

  return prog;
}

/**
 * @param {string} socketPath
 * @returns {Promise<JsonRpc>}
 */
function connectRpc(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => {
      resolve(new JsonRpc(socket));
    });
    socket.on("error", (err) => {
      const nodeErr = /** @type {Error & { code?: string }} */ (err);
      if (nodeErr.code === "ECONNREFUSED" || nodeErr.code === "ENOENT") {
        reject(
          new Error(
            `Could not connect to the setkamost daemon (socket: ${socketPath}).\n` +
              `The daemon doesn't appear to be running. Start it with: setkamost daemon start`,
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

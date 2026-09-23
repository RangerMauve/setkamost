import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

import xdg from "xdg-portable";

/** @type {import("xdg-portable").XDG} */
// @ts-ignore default export is callable at runtime but types differ
const xdgInstance = xdg;

/**
 * Absolute path to the systemd user unit file.
 * @returns {string}
 */
export function unitFilePath() {
  return join(xdgInstance.config(), "systemd", "user", "setkamost.service");
}

/**
 * Generate the systemd unit file content.
 * @param {string} execPath - Absolute path to the node binary
 * @param {string} scriptPath - Absolute path to the setkamost entry script
 * @param {string} socketPath - Socket path for the daemon
 * @returns {string}
 */
export function generateUnitFile(execPath, scriptPath, socketPath) {
  return [
    "[Unit]",
    "Description=setkamost P2P HTTP proxy daemon",
    "After=network.target",
    "",
    "[Service]",
    `ExecStart=${execPath} ${scriptPath} daemon start --socket ${socketPath}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Run a systemctl --user command.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export function runSystemctl(args) {
  return new Promise((resolveP, reject) => {
    execFile("systemctl", ["--user", ...args], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolveP();
    });
  });
}

/**
 * Install the systemd user service.
 * @param {object} options
 * @param {string} options.socketPath - Socket path for the daemon
 * @param {boolean} [options.start=true] - Whether to start the service after enabling
 * @returns {Promise<{unitPath: string, started: boolean}>}
 */
export async function installService({ socketPath, start = true }) {
  const unitPath = unitFilePath();
  const scriptPath = resolve(process.argv[1] ?? "setkamost");
  const content = generateUnitFile(process.execPath, scriptPath, socketPath);

  await mkdir(dirname(unitPath), { recursive: true });
  await writeFile(unitPath, content);

  await runSystemctl(["daemon-reload"]);
  await runSystemctl(["enable", "setkamost.service"]);

  let started = false;
  if (start) {
    await runSystemctl(["start", "setkamost.service"]);
    started = true;
  }

  return { unitPath, started };
}

/**
 * Uninstall the systemd user service.
 * @returns {Promise<{removed: boolean}>}
 */
export async function uninstallService() {
  const unitPath = unitFilePath();

  try {
    await runSystemctl(["disable", "--now", "setkamost.service"]);
  } catch {
    // Service may not be running or enabled
  }

  let removed = false;
  try {
    await unlink(unitPath);
    removed = true;
  } catch {
    // Unit file may not exist
  }

  try {
    await runSystemctl(["daemon-reload"]);
  } catch {
    // Non-fatal
  }

  return { removed };
}

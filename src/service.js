import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

import xdg from "xdg-portable";

/** @type {import("xdg-portable").XDG} */
// @ts-ignore default export is callable at runtime but types differ
const xdgInstance = xdg;

/** @type {"systemd" | "launchd"} */
const platform = process.platform === "darwin" ? "launchd" : "systemd";

const APP_ID = "moe.mauve.setkamost";
const SERVICE_NAME = `${APP_ID}.daemon`;

/**
 * Absolute path to the service unit file (platform-specific).
 * @returns {string}
 */
export function unitFilePath() {
  if (platform === "launchd") {
    return join(homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);
  }
  return join(xdgInstance.config(), "systemd", "user", "setkamost.service");
}

/**
 * Generate the service unit file content (platform-specific).
 * @param {string} execPath - Absolute path to the node binary
 * @param {string} scriptPath - Absolute path to the setkamost entry script
 * @param {string} socketPath - Socket path for the daemon
 * @returns {string}
 */
export function generateUnitFile(execPath, scriptPath, socketPath) {
  if (platform === "launchd") {
    return generatePlist(execPath, scriptPath, socketPath);
  }
  return generateSystemdUnit(execPath, scriptPath, socketPath);
}

/**
 * @param {string} execPath
 * @param {string} scriptPath
 * @param {string} socketPath
 * @returns {string}
 */
export function generateSystemdUnit(execPath, scriptPath, socketPath) {
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
 * @param {string} execPath
 * @param {string} scriptPath
 * @param {string} socketPath
 * @returns {string}
 */
export function generatePlist(execPath, scriptPath, socketPath) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${SERVICE_NAME}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${execPath}</string>`,
    `    <string>${scriptPath}</string>`,
    "    <string>daemon</string>",
    "    <string>start</string>",
    "    <string>--socket</string>",
    `    <string>${socketPath}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * Run a platform-specific service manager command.
 * @param {string[]} args - Arguments to pass
 * @returns {Promise<void>}
 */
export function runServiceManager(args) {
  return new Promise((resolveP, reject) => {
    if (platform === "launchd") {
      execFile("launchctl", args, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolveP();
      });
    } else {
      execFile("systemctl", ["--user", ...args], (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolveP();
      });
    }
  });
}

/**
 * Install the platform service.
 * @param {object} options
 * @param {string} options.socketPath - Socket path for the daemon
 * @param {boolean} [options.start=true] - Whether to start the service after installing
 * @returns {Promise<{unitPath: string, started: boolean}>}
 */
export async function installService({ socketPath, start = true }) {
  const unitPath = unitFilePath();
  const scriptPath = resolve(process.argv[1] ?? "setkamost");
  const content = generateUnitFile(process.execPath, scriptPath, socketPath);

  await mkdir(dirname(unitPath), { recursive: true });
  await writeFile(unitPath, content);

  let started = false;
  if (platform === "launchd") {
    if (start) {
      await runServiceManager(["load", unitPath]);
      started = true;
    }
  } else {
    await runServiceManager(["daemon-reload"]);
    await runServiceManager(["enable", "setkamost.service"]);
    if (start) {
      await runServiceManager(["start", "setkamost.service"]);
      started = true;
    }
  }

  return { unitPath, started };
}

/**
 * Uninstall the platform service.
 * @returns {Promise<{removed: boolean}>}
 */
export async function uninstallService() {
  const unitPath = unitFilePath();

  if (platform === "launchd") {
    await runServiceManager(["unload", unitPath]).catch(() => {});
  } else {
    await runServiceManager(["disable", "--now", "setkamost.service"]).catch(
      () => {},
    );
    await runServiceManager(["daemon-reload"]).catch(() => {});
  }

  let removed = false;
  try {
    await unlink(unitPath);
    removed = true;
  } catch {
    // Unit file may not exist
  }

  return { removed };
}

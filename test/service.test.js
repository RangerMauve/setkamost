import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { createProgram } from "../src/cli.js";
import {
  generateUnitFile,
  installService,
  uninstallService,
  unitFilePath,
} from "../src/service.js";
import { Daemon } from "../src/daemon.js";
import { MockProxy } from "./fixtures/mock-proxy.js";

/**
 * Create a temp dir with a fake systemctl stub on PATH.
 * @param {string} suffix
 * @returns {{ base: string; configDir: string; stateDir: string; path: string; cleanup: () => void }}
 */
function makeServiceTestEnv(suffix) {
  const base = join(tmpdir(), `setkamost-svc-${suffix}-${Date.now()}`);
  const configDir = join(base, "config");
  const stateDir = join(base, "state");
  const binDir = join(base, "bin");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  return {
    base,
    configDir,
    stateDir,
    path: `${binDir}:${process.env.PATH}`,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/**
 * Run a CLI command via commander, capturing console output.
 * @param {string[]} args
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {Promise<{ log: string; err: string; exitCode: number | null }>}
 */
async function runCli(args, options = {}) {
  /** @type {string[]} */
  const logChunks = [];
  /** @type {string[]} */
  const errChunks = [];
  /** @type {number | null} */
  let exitCode = null;

  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  /** @type {Record<string, string | undefined>} */
  const savedEnv = {};

  console.log = (...a) => {
    logChunks.push(
      a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "),
    );
  };
  console.error = (...a) => {
    errChunks.push(
      a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "),
    );
  };
  process.exit = (code) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error("__EXIT__");
  } /** @type {typeof process.exit} */;

  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  }

  try {
    const program = createProgram();
    await program.parseAsync(["node", "setkamost", ...args]);
  } catch (err) {
    if (/** @type {Error} */ (err).message !== "__EXIT__") throw err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  return { log: logChunks.join("\n"), err: errChunks.join("\n"), exitCode };
}

describe("generateUnitFile", () => {
  it("produces valid unit file content", () => {
    const content = generateUnitFile(
      "/usr/bin/node",
      "/opt/setkamost/bin/setkamost.js",
      "/tmp/test.sock",
    );
    assert.match(content, /\[Unit\]/);
    assert.match(content, /Description=setkamost P2P HTTP proxy daemon/);
    assert.match(content, /After=network\.target/);
    assert.match(content, /\[Service\]/);
    assert.match(
      content,
      /ExecStart=\/usr\/bin\/node \/opt\/setkamost\/bin\/setkamost\.js daemon start --socket \/tmp\/test\.sock/,
    );
    assert.match(content, /Restart=on-failure/);
    assert.match(content, /RestartSec=5/);
    assert.match(content, /\[Install\]/);
    assert.match(content, /WantedBy=default\.target/);
  });
});

describe("installService / uninstallService", () => {
  /** @type {ReturnType<typeof makeServiceTestEnv>} */
  let env;
  /** @type {string | undefined} */
  let origPath;

  before(() => {
    env = makeServiceTestEnv("lib");
    process.env.XDG_CONFIG_HOME = env.configDir;
    origPath = process.env.PATH;
    process.env.PATH = env.path;
  });

  after(() => {
    delete process.env.XDG_CONFIG_HOME;
    if (origPath !== undefined) process.env.PATH = origPath;
    env.cleanup();
  });

  it("installService writes unit file", async () => {
    const { unitPath, started } = await installService({
      socketPath: "/tmp/fake.sock",
      start: false,
    });
    assert.equal(started, false);
    assert.equal(
      unitPath,
      join(env.configDir, "systemd", "user", "setkamost.service"),
    );
    assert.ok(existsSync(unitPath));
    const content = readFileSync(unitPath, "utf8");
    assert.match(content, /--socket \/tmp\/fake\.sock/);
  });

  it("installService is idempotent", async () => {
    const first = await installService({
      socketPath: "/tmp/fake.sock",
      start: false,
    });
    const second = await installService({
      socketPath: "/tmp/fake.sock",
      start: false,
    });
    assert.equal(first.unitPath, second.unitPath);
    assert.ok(existsSync(second.unitPath));
  });

  it("uninstallService removes the unit file", async () => {
    await installService({ socketPath: "/tmp/fake.sock", start: false });
    const { removed } = await uninstallService();
    assert.equal(removed, true);
    assert.equal(existsSync(unitFilePath()), false);
  });

  it("uninstallService handles missing unit file", async () => {
    const { removed } = await uninstallService();
    assert.equal(removed, false);
  });
});

describe("daemon status", () => {
  /** @type {string} */
  let socketPath;
  /** @type {Daemon} */
  let daemon;
  /** @type {MockProxy} */
  let proxy;

  before(async () => {
    proxy = new MockProxy();
    socketPath = join(tmpdir(), `setkamost-status-${Date.now()}.sock`);
    const storagePath = join(tmpdir(), `setkamost-status-${Date.now()}-data`);
    daemon = new Daemon({ proxy, socketPath, storagePath });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
  });

  it("reports running when daemon is active", async () => {
    const { log, exitCode } = await runCli([
      "daemon",
      "status",
      "--socket",
      socketPath,
    ]);
    assert.match(log, /running/);
    assert.match(log, new RegExp(socketPath));
    assert.equal(exitCode, null);
  });

  it("reports not running when no daemon", async () => {
    const deadSocket = join(tmpdir(), `setkamost-dead-${Date.now()}.sock`);
    const { log, exitCode } = await runCli([
      "daemon",
      "status",
      "--socket",
      deadSocket,
    ]);
    assert.match(log, /not running/);
    assert.equal(exitCode, 1);
  });
});

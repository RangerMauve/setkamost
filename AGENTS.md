# AGENTS.md — setkamost

## What this is

A peer-to-peer HTTP proxy that exposes local HTTP services, remote HyperDHT URLs, and static folders over the HyperDHT network. Ships as a CLI, an Electron GUI, and an importable ESM library. State persists across daemon restarts via JSON.

## Language & Runtime

- **Plain JavaScript (ESM)** — no TypeScript, no build step.
- **Node.js ≥ 20** — uses `#` private fields, `node:test`, `node:assert`.
- Types are expressed via **JSDoc** comments, checked by `tsc --noEmit` (with `checkJs: true`).
- Declaration files are emitted to `dist/` via `tsc` (emitDeclarationOnly).

## Commands

| Task             | Command                                             |
| ---------------- | --------------------------------------------------- |
| Run all tests    | `npm test` (node:test suites + xvfb Electron UI test) |
| Lint + typecheck | `npm run lint` (eslint --fix + tsc --noEmit)         |
| Run the GUI      | `npm start` (electron app/index.js)                  |
| Run the CLI      | `node bin/setkamost.js <command>`                    |

## Workflow

When making code changes:

1. **Write tests for new features.** Every new proxy method, RPC endpoint, CLI command, or non-trivial function gets a test file in `test/`.
2. **Run `npm run lint` after each logical code change.** Fix any lint or type errors before moving on.
3. **Run `npm test` when you're done.** All tests must pass before the work is considered complete.

## Project Structure

```
src/
  proxy.js          HyperHttpProxy class — the core P2P proxy (local ports, remote URLs, folders)
  fileserver.js     makeFileServer() — standalone hyperdht static file server
  urls.js           makeURL/parseURL — hyper+http:// URL ↔ Buffer conversion
  jsonrpc.js        JsonRpc class — Unix socket JSON-RPC protocol
  daemon.js         Daemon class — Unix socket server wrapping the proxy + state persistence
  service.js        systemd user service management (install/uninstall/status helpers)
  cli.js            CLI commands (commander-based) — daemon start/stop/install/uninstall/status, expose-*, list
  index.js          Public library exports
app/
  index.js          Electron main process
  preload.js        contextBridge exposing window.proxyApi
  index.html        Renderer UI
  style.css         Styling
bin/
  setkamost.js      CLI entry point (shebang wrapper around src/cli.js)
test/
  *.test.js         node:test suites
  ui.js             Electron UI test (run under xvfb)
  fixtures/         Test fixtures
  utils/            Shared test helpers
types/
  *.d.ts            Type declarations for untyped deps (hyperdht, hypercore-id-encoding)
dist/               Emitted .d.ts files (tsc output, not committed)
```

## Key Conventions

### HyperHttpProxy (`src/proxy.js`)

The central class. Three maps track active services:

- `#localPorts: Map<number, {seed, url, destroy}>` — local HTTP ports exposed to the DHT
- `#folders: Map<string, {seed, url, destroy}>` — folders exposed as file servers
- `#remoteProxies: Map<string, {port, destroy}>` — remote DHT URLs proxied to local ports

Each entry stores a `destroy` closure for cleanup. `HyperHttpProxy.destroy()` tears down all three maps.

Key methods:
- `exposeLocalPort(port, seed?)` → `hyper+http://` URL
- `exposeRemoteAsLocal(url, defaultPort?)` → local port number
- `exposeFolder(rootFolder, seed?)` → `hyper+http://` URL
- `list()` → human-readable state (URLs + hex seeds)
- `toJSON()` → serializable state (hex seeds + ports, for persistence)
- `loadJSON(json)` → restore from `toJSON()` output

### Daemon (`src/daemon.js`)

Wraps the proxy behind a Unix domain socket JSON-RPC server. Persists `proxy.toJSON()` to `<storagePath>/state.json` after every mutation and on shutdown. Loads state on startup before accepting connections. Writes a PID file at `<socketPath>.pid`.

### Service (`src/service.js`)

Cross-platform service management (systemd on Linux, launchd on macOS). Auto-detects via `process.platform`. Exports:
- `generateUnitFile(execPath, scriptPath, socketPath)` → unit file content (systemd INI or plist XML)
- `generateSystemdUnit(...)` / `generatePlist(...)` → individual generators
- `installService({socketPath, start?})` → writes unit file, enables + optionally starts
- `uninstallService()` → disables, stops, removes unit file
- `unitFilePath()` → absolute path to the unit file
- `runServiceManager(args)` → promisified `systemctl --user` / `launchctl` call

Service identifiers:
- Linux: `setkamost.service` at `~/.config/systemd/user/`
- macOS: `moe.mauve.setkamost.daemon` at `~/Library/LaunchAgents/`

### JSON-RPC (`src/jsonrpc.js`)

Line-delimited JSON-RPC over a Unix socket. The Daemon registers handlers: `list`, `exposeLocalPort`, `exposeRemoteAsLocal`, `exposeFolder`.

### Electron App (`app/`)

- Main process (`index.js`) connects to the daemon via the socket, or spawns one in-process.
- Preload (`preload.js`) exposes `window.proxyApi` via `contextBridge`. `contextIsolation` is on, `nodeIntegration` is off.
- Renderer communicates via `ipcRenderer.invoke` → `ipcMain.handle` → JSON-RPC to the daemon.
- Tray icon toggles the main window. Closing the window does not quit.

### CLI (`src/cli.js` + `bin/setkamost.js`)

Commander-based. Commands: `daemon start`, `daemon stop`, `daemon install`, `daemon uninstall`, `daemon status`, `expose-local`, `expose-remote`, `expose-folder`, `list`. All accept `--socket <path>` (defaults to `$SETKAMOST_SOCKET` or `~/.local/state/setkamost/sock`). `daemon install` supports `--no-start`. `daemon install`/`uninstall` are cross-platform (systemd on Linux, launchd on macOS).

### Persistence

- State file: `<storagePath>/state.json` (defaults to `~/.local/share/setkamost/state.json`)
- Socket: `~/.local/state/setkamost/sock`
- PID file: `<socket>.pid`
- Uses `xdg-portable` for path resolution.

### Testing

- Uses built-in `node:test` + `node:assert/strict`.
- No mocking framework. Tests are self-contained.
- UI test (`test/ui.js`) runs under `xvfb-run` with Electron.
- Run a single file: `node --test test/specific.test.js`

## Code Style

- Semicolons are used. Prettier handles formatting.
- `import`/`export` (ESM), never `require`.
- JSDoc on all exported functions/classes. `@ts-ignore` / `@ts-expect-error` sparingly.
- Private class fields use `#` (e.g. `#dht`, `#localPorts`).
- Error messages are user-facing — keep them helpful but concise.

## Commit Messages

Conventional Commits style: `type: summary`.

| Type       | Use for                                                    |
| ---------- | ---------------------------------------------------------- |
| `feat`     | New capabilities (proxy methods, CLI commands, GUI features) |
| `fix`      | Bug fixes, edge cases, incorrect behavior                  |
| `refactor` | Restructuring without behavior change                      |
| `perf`     | Performance improvements                                   |
| `test`     | Adding or fixing tests                                     |
| `docs`     | Documentation changes (including AGENTS.md, README, docs/) |
| `chore`    | Housekeeping — formatting, deps, type fixes, config        |

Rules:

- **One line.** Short, natural description. No trailing period.
- **No scope.** The type prefix is enough.
- **Name the thing.** Lead with the feature/command/method being changed.
- Don't prefix with "WIP" or "update" — commit in logical units.

## Keeping AGENTS.md Current

Update this file whenever you make a change that would cause a _new_ agent (or a future-you with amnesia) to do something wrong or waste time. Specifically:

**Update when:**

- A new source directory or top-level module is added
- A proxy method or RPC endpoint changes its contract (new required params, different return shape)
- A build/test/lint command changes
- A new external dependency changes the dev workflow (e.g. needs a native binary, env var)
- A convention is established or retired
- A gotcha is discovered that cost time to figure out

**Don't update for:**

- Internal refactors that don't change external contracts
- Bug fixes that don't alter structure
- Content changes within existing files

The test: _"Would an agent reading only this file make a mistake or get confused?"_ If yes, update it.

## Gotchas

- There is **no build step** for source. Edit `.js` directly. `tsc` only emits `.d.ts` files to `dist/`.
- `HyperHttpProxy` requires a `Hyperdht` instance passed in — it does not create one.
- The daemon and the Electron GUI share state through the daemon's socket — the GUI never talks to the proxy directly.
- `exposeFolder` requires an **absolute** path. Relative paths throw.
- State persistence is best-effort: a corrupt or missing `state.json` will not prevent daemon startup.
- The `#destroy` closures in the proxy maps capture the server handle — calling `destroy()` on an already-destroyed entry is not safe.
- Electron tests require `xvfb-run` (X virtual framebuffer) — they will fail on headless CI without it.

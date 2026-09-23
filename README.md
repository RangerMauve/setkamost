# setkamost (Сеткамост)

Expose your HTTP services over peer-to-peer connections with a friendly Electron-based graphical interface.

## Name

**Setkamost** — a blend of the Russian words **сетка** (setka, "mesh/net") and **мост** (most, "bridge"). Think of it as a mesh bridge: a web of tunnels connecting local services to the HyperDHT network.

## CLI

Install globally or use via `npx`:

```sh
npm install -g setkamost
```

All commands accept a global `--socket <path>` flag to point at a non-default daemon socket (defaults to `~/.local/state/setkamost/sock`, or `$SETKAMOST_SOCKET`).

```sh
setkamost --help
```

### Daemon

The daemon is a Unix-domain-socket JSON-RPC server that owns the `HyperHttpProxy` instance and persists state to `~/.local/share/setkamost/state.json` across restarts.

```sh
setkamost daemon start          # start the daemon (restores prior state)
setkamost daemon stop           # send SIGTERM to the daemon
setkamost daemon status         # check if the daemon is running
setkamost daemon install        # install as a system service (systemd or launchd)
setkamost daemon install --no-start  # install without starting
setkamost daemon uninstall      # remove the system service
```

The daemon writes a PID file at `<socket>.pid` on startup and cleans it up on exit.

#### System service

`daemon install` auto-detects the platform:

- **Linux** — installs a systemd user service at `~/.config/systemd/user/setkamost.service`
- **macOS** — installs a LaunchAgent at `~/Library/LaunchAgents/moe.mauve.setkamost.daemon.plist`

Both auto-restart on crash and start at login. `daemon uninstall` stops and removes the service.

### Expose services

```sh
# Expose a local HTTP port → returns a hyper+http:// URL
setkamost expose-local 3000
# → hyper+http://z2b4r6d7f8a9.../

# Expose a remote HyperDHT URL as a local port
setkamost expose-remote hyper+http://z2b4r6d7f8a9.../ --port 8080
# → 8080

# Expose a folder as a static file server
setkamost expose-folder /path/to/docs
# → hyper+http://w5c3e6a9b2d8.../
```

### List

```sh
setkamost list
# {
#   "localPorts": { "3000": { "seed": "...", "url": "hyper+http://.../" } },
#   "remoteProxies": { "hyper+http://.../": { "port": 8080 } },
#   "folders": { "/path/to/docs": { "seed": "...", "url": "hyper+http://.../" } }
# }
```

## Electron App

```sh
npm start
```

The app is a thin GUI on top of the same daemon the CLI talks to.

- **On launch** it tries to connect to an already-running daemon via the socket. If none exists it spawns one in-process.
- **Tray icon** — clicking it toggles the main window. The context menu offers Show / Quit. Closing the window doesn't quit the app.
- **Main window** has three sections, each with a form to add entries and a live list:
  - *Expose Local* — enter a port number
  - *Expose Remote As Local* — paste a `hyper+http://` URL and optionally a local port
  - *Share Folders* — pick a directory with the folder picker or type a path
- The renderer communicates with the main process over `ipcRenderer.invoke` → `ipcMain.handle`. All proxy operations are forwarded to the daemon via JSON-RPC (`proxy:exposeLocalPort`, `proxy:list`, etc.), so the GUI and CLI share the same state.
- The preload script exposes a `window.proxyApi` object with `exposeLocalPort`, `exposeRemoteAsLocal`, `exposeFolder`, `list`, `toJSON`, `selectFolder`, and `destroy`. `contextIsolation` is on and `nodeIntegration` is off.

## Library

`setkamost` is importable as an ESM library. The package entry point (`exports."."`) is `src/proxy.js`.

### HyperHttpProxy

```js
import Hyperdht from "hyperdht";
import { HyperHttpProxy } from "setkamost";

const dht = new Hyperdht();
const proxy = new HyperHttpProxy({ dht });

// Expose a local port
const url = await proxy.exposeLocalPort(3000);
console.log(url); // hyper+http://z2b4r6d7f8a9.../

// Optionally pass a seed for a deterministic URL
const { randomBytes } = await import("node:crypto");
const seed = randomBytes(32);
const url2 = await proxy.exposeLocalPort(4000, seed);

// Expose a remote service locally
const port = await proxy.exposeRemoteAsLocal("hyper+http://z2b4r6d7f8a9.../");
console.log(`Now available at http://localhost:${port}`);

// Expose a folder as a file server
const folderUrl = await proxy.exposeFolder("/path/to/docs");
console.log(folderUrl); // hyper+http://w5c3e6a9b2d8.../

// Inspect state
console.log(proxy.list());   // { localPorts, remoteProxies, folders } — with URLs
console.log(proxy.toJSON()); // { localPorts, remoteProxies, folders } — with seeds (for persistence)

// Restore state from a previous session
await proxy.loadJSON(proxy.toJSON());

// Tear everything down
await proxy.destroy();
```

Options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dht` | `HyperDHT` | required | The HyperDHT instance |
| `onError` | `(err: Error) => void` | `console.error` | Called on pipeline/stream errors |

### makeFileServer

Standalone file server, independent of `HyperHttpProxy`:

```js
import Hyperdht from "hyperdht";
import { randomBytes } from "node:crypto";
import { makeFileServer } from "setkamost/src/fileserver.js";

const dht = new Hyperdht();
const server = await makeFileServer({
  dht,
  rootFolder: "/path/to/serve",
  seed: randomBytes(32),
});

console.log(server.url);    // the hyper+http:// URL
console.log(server.keyPair); // { publicKey, secretKey }
await server.destroy();
```

Serves `GET` (file contents with correct `content-type`, `content-length`, `last-modified`) and `HEAD` requests. Directories return a JSON array of entries. Path traversal is blocked.

### URL helpers

```js
import { makeURL, parseURL } from "setkamost/src/urls.js";

makeURL(publicKey);  // Buffer → "hyper+http://z2b4r6d7f8a9.../"
parseURL(url);       // "hyper+http://z2b4r6d7f8a9.../" → Buffer (public key)
```

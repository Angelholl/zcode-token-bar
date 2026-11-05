# zcode-token-bar

English | [简体中文](README.md)

A **live token usage bar** for the ZCode desktop app, in two flavours: a **statusline plugin** (one real usage line at the end of every reply, one-click install from a plugin marketplace) or a **floating bar** below the chat input box with turns / steps, output speed, total tokens, cache hit rate and context usage — click any pill for details.

![Bar preview](assets/bar-preview.png)

> **Unofficial.** Not affiliated with Z.ai or DeepSeek. Use at your own risk.
> This tool does **not** modify the ZCode installation. It only injects the bar into the
> renderer while a local debugging port is open; all data comes from **read-only** queries
> against the local SQLite database. Nothing leaves your machine.

## Features

| Pill | Shows | Click for |
|---|---|---|
| Activity | `N turns M steps · X tok/s` | model time / tool time / avg TTFT / output speed |
| Usage | `X tok · cache hit P%` | exact totals + uncached input / cache read / cache write / output |
| Context | `Context P%` + mini meter | latest-turn context / limit / ratio, with limit source |

- Follows the input box in real time as it grows with long content (ResizeObserver); floats above the composer when the window is too short
- Context limit is resolved per current model (provider config → same-model catalog → 1M default); overridable via environment variable
- Crash-safe: uncaught exceptions are logged only, the controller keeps running

## Install (Windows)

Requirements: Node.js 22+, Windows 10+.

### Option 1: Plugin marketplace (statusline, recommended, no debug port needed)

Appends one real usage line (turns / steps / tok/s / tokens / cache hit / context %) to the end of every reply:

1. Open ZCode **Plugin Marketplace → Add → Add Plugin Marketplace**;
2. Paste either source (first one recommended):
   - GitHub repo: `Angelholl/zcode-token-bar`
   - Direct catalog: `https://raw.githubusercontent.com/Angelholl/zcode-token-bar/main/marketplace.json`
3. Under **Personal → zcode-token-bar**, find **ZCode Token Bar** and click Install;
4. Start a new session — every reply now ends with a usage line; `/status` shows it on demand.

### Option 2: Floating bar (CDP injection, full pills UI)

The bar floats below the chat input box; click a pill for details:

```cmd
git clone https://github.com/Angelholl/zcode-token-bar.git
cd zcode-token-bar
start.cmd
```

> **Note:** if ZCode is already running, `start.cmd` asks to kill it and relaunch with the
> debugging port — **save unfinished work in ZCode first**. The bar appears below the input
> box about 2 seconds after the relaunch.

Stop: `stop.cmd`.

### Let AI do it

Paste one of these prompts into the ZCode chat box:

**Floating bar (Option 2):**

```text
Please install the zcode-token-bar floating bar for me:
1. Clone https://github.com/Angelholl/zcode-token-bar to a suitable directory;
2. Run start.cmd (if ZCode needs a restart, remind me to save unfinished work first);
3. Confirm the bar appears below the input box and tell me where stop.cmd is.
```

**Statusline plugin (Option 1):**

```text
Please add https://github.com/Angelholl/zcode-token-bar as a ZCode plugin marketplace
and install the "ZCode Token Bar" (token-bar-statusline) plugin,
then tell me how to verify the usage line at the end of replies in a new session.
```

## Uninstall

**Floating bar (Option 2):**

1. Run `stop.cmd` to stop the controller;
2. Launch ZCode normally (without the debug port) and the bar is gone;
3. Delete this folder. The tool never writes into the ZCode install directory — nothing left behind.

**Statusline plugin (Option 1):** disable or uninstall it under **Settings → Plugins**.

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `ZSTB_PORT` | `9333` | CDP debugging port, must match ZCode's launch flag |
| `ZSTB_INTERVAL` | `5000` | Data refresh interval (ms); bar repositioning is event-driven and unaffected |
| `ZSTB_CONTEXT_LIMIT` | auto | Force the context limit (tokens) |
| `ZSTB_DB` | `~/.zcode/cli/db/db.sqlite` | Database path |

## How it works

```
db.sqlite (read-only) ──5s poll──> Node controller ──CDP WebSocket──> injected bar in renderer
      turn_usage / model_usage / tool_usage            Runtime.evaluate + addBinding
```

The controller queries ZCode's local database read-only every 5 seconds and pushes stats
into the renderer over CDP (`--remote-debugging-port`). On the page side a ResizeObserver
tracks the input box and composer card, so repositioning is event-driven and instant. The
page can wake the controller through bindings (session switch / manual refresh).

## License

MIT. Third-party attributions: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
(stats pills UI adapted from DeepSeek Harness, MIT; ideas inspired by ZcodeTokbar).

# zcode-token-bar

English | [简体中文](README.md)

A **live token usage bar** for the ZCode desktop app: it floats below the chat input box and shows, for the current session, turns / steps, output speed, total tokens, cache hit rate and context usage. Click any pill for details.

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
- **Lost-port self-heal**: after a ZCode auto-update the updater relaunches ZCode without the
  debug port; when the controller detects "ZCode running but the port is down" for ~15 seconds
  it restarts ZCode with the port automatically (max 3 retries, 2-minute cooldown; in-flight
  generation is interrupted by the restart). Set `ZSTB_HEAL=0` to disable.

## Install (Windows)

Requirements: Node.js 22+, Windows 10+.

```cmd
git clone https://github.com/Angelholl/zcode-token-bar.git
cd zcode-token-bar
start.cmd
```

> **Note:** if ZCode is already running, `start.cmd` asks to kill it and relaunch with the
> debugging port — **save unfinished work in ZCode first**. The bar appears below the input
> box about 2 seconds after the relaunch.

Stop: `stop.cmd` (stops the controller via `%USERPROFILE%\.zcode\tools\session-stats-cdp\controller.pid`, leaves ZCode untouched).

### Autostart at boot

Run once:

```cmd
boot-start.cmd
```

This registers "ZCode (with the debug port) + the token bar controller" into your Startup
folder (`zcode-token-bar.lnk`), so both launch together at logon. `boot-start.cmd` is
non-interactive and idempotent: it starts ZCode with `--remote-debugging-port=9333` only
when ZCode is not running, and starts the controller only when it is not running — safe
to re-run.

Note: if you launch ZCode manually (without the debug port) before the startup entry
runs, that session won't show the bar — run `start.cmd` once instead. To remove the
autostart entry, delete `zcode-token-bar.lnk` from the Startup folder.

### Let AI do it

Paste this prompt into the ZCode chat box:

```text
Please install the zcode-token-bar floating bar for me:
1. Clone https://github.com/Angelholl/zcode-token-bar to a suitable directory;
2. Run start.cmd (if ZCode needs a restart, remind me to save unfinished work first);
3. Confirm the bar appears below the input box and tell me where stop.cmd is.
```

## Uninstall

1. Run `stop.cmd` to stop the controller;
2. Launch ZCode normally (without the debug port) and the bar is gone;
3. Delete this folder. The tool never writes into the ZCode install directory — nothing left behind.

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

# Rust Docker Image

This directory contains the Rust dedicated server image used by OVHcloud Game Panel.

The image installs and runs a Rust dedicated server through SteamCMD (Steam app id `258550`).

## ✅ Capabilities

| Capability | Support |
| --- | --- |
| Install / update via SteamCMD | Supported (with automatic retry on the transient SteamCMD "Missing configuration" error) |
| Console commands | Supported (WebRCON) |
| Hot backup while running | Supported |
| Cold backup while stopped | Supported |
| Restores | Supported |
| Health check | Supported |
| Mods | Supported (Oxide/uMod; installed on demand) |

## ⚙️ Runtime model

Important paths:

- `/data`: persistent data path;
- `/data/server`: Rust installation directory (SteamCMD);
- `/data/server/server/<identity>`: the world save — map, world `.sav`, player databases
  (`player.*.db`, `clans`, …) and `cfg/` (`server.cfg`, `users.cfg`, `bans.cfg`);
- `/backups`: panel-managed backup archives (see Operational scripts);
- `/run/rust`: temporary runtime state (PID file, effective RCON credentials).

Default exposed ports:

- `28015/udp` (game)
- `28017/udp` (Steam query)
- `28016/tcp` (WebRCON)
- `28082/tcp` (Rust+ companion app)

The game/query/app ports are **advertised** to clients, so the panel must map them 1:1 with the
host; the RCON port is a direct connection and may be remapped freely. Rust ignores stdin, so
console commands are sent over **WebRCON**, enabled by default with a password (generated if not
provided; Rust disables RCON for passwords shorter than 8 characters). The map cache
(`*.map` and the occlusion `.dat`) is deterministic from the seed and is regenerated at startup,
so it is excluded from backups.

## 🔧 Runtime inputs

Boolean inputs accept `true` / `false` (and `1`, `yes`, `on` / `0`, `no`, `off`), case-insensitive.

| Input | Default | Allowed values | Purpose |
| --- | --- | --- | --- |
| `RUST_START_PARAMS` | *(empty)* | any launch args | Startup convars appended to the server (e.g. `+server.hostname "…" +server.maxplayers 100 +server.worldsize 4000 +server.seed 12345`). Panel-driven. |
| `RUST_SERVER_IDENTITY` | `rust-server` | any string | `server.identity`; determines the save folder under `server/<identity>`. |
| `RUST_SERVER_PORT` | `28015` | `1`–`65535` | Game port (`server.port`). Advertised → map 1:1. |
| `RUST_QUERY_PORT` | `28017` | `1`–`65535` | Steam query port (`server.queryport`). Advertised → map 1:1. |
| `RUST_RCON_ENABLED` | `true` | boolean | Enable WebRCON (required for the panel console and clean shutdown). |
| `RUST_RCON_PORT` | `28016` | `1`–`65535` | WebRCON port (`rcon.port`). Direct connection → may be remapped. |
| `RUST_RCON_PASSWORD` | *(generated)* | string (≥ 8 chars) | WebRCON password. Generated randomly if unset; must be at least 8 characters or the container refuses to start (Rust disables RCON below that). |
| `RUST_RUSTPLUS_ENABLED` | `true` | boolean | Enable the Rust+ companion app (`app.port`). |
| `RUST_APP_PORT` | `28082` | `1`–`65535` | Rust+ companion port (`app.port`). Advertised → map 1:1. |
| `RUST_UPDATE_ON_START` | `false` | boolean | Run a SteamCMD update on every start. |
| `RUST_VALIDATE_ON_START` | `false` | boolean | Validate installed files via SteamCMD on start. |
| `HEALTHCHECK_PORT` | `28015` | `1024`–`65535` | UDP game port the health check expects the server to bind. |
| `HEALTHCHECK_REQUIRE_BIND` | `true` | boolean | Require the UDP game port to be bound for the container to be healthy. |
| `STOP_TIMEOUT_SECONDS` | `300` | integer seconds | Grace period after `quit` before the server is force-killed on stop. |

## 🛠️ Operational scripts

| Script | Purpose |
| --- | --- |
| `/app/send-command.sh <command>` | Sends a command to the running server over WebRCON (e.g. `status`, `say`, `save`) and prints the response. |
| `/app/backup.sh` | Creates a timestamped `.tar.gz` in `/backups` of the world save (the live `.sav`, player `.db*`, `cfg/`, `companion.id`). Excludes the regenerable map cache and Rust's own rotating `.sav` backups. Hot (`save` + wait for "Saving complete") if the server is running, cold otherwise. |
| `/app/restore.sh <backup>` | Restores a backup archive over the current world save (staging + rollback on failure). Requires the server to be stopped; does not stop/start it. A matching map cache is kept for a fast start, otherwise Rust regenerates it. |
| `/app/install-oxide.sh [version]` | Downloads and installs Oxide/uMod (`latest` or a specific version, e.g. `2.0.7529`) over the server files, and creates `oxide/plugins/` so plugins can be dropped before the first start. Requires the server to be stopped; restart to load. Re-running with another version applies it as an overlay update. |
| `/app/healthcheck.sh` | Reports container health to Docker. |

## 🧩 Mods

Rust is modded server-side with **Oxide/uMod** .
Install the framework with `/app/install-oxide.sh` (optionally passing a version) while the server
is stopped; the next start loads Oxide, which creates its `oxide/` tree. Drop plugin `.cs` files
into `oxide/plugins/` (config and data live under `oxide/config/` and `oxide/data/`); they are
hot-loaded.

Installing Oxide overlays some of the server's managed assemblies, so a Rust game update
(via SteamCMD) overwrites them — reinstall Oxide with `/app/install-oxide.sh` afterwards. A restart
is required for changes to take effect. (Carbon is not bundled.)

---
title: "bug: server serves an empty vault and systemd crash-loops when a stray uvicorn holds the port"
repo: https://github.com/ZenithFr/obsidian-api-sync
branch: main
head: a323d45
severity: high (silent data-path failure + service unavailable)
labels: [bug, server, stability, vault-path]
---

# Bug Report: Empty-vault dead-end + crash-loop after a stray uvicorn grabs :8000

## Summary

Two independent root causes combine into a single user-visible failure: the API server
appears "stuck on loading vault" and the systemd unit enters an infinite restart loop.

1. **Relative vault path.** `vault_path` is stored in SQLite exactly as configured
   (default `./vault`) and resolved against the process working directory at request
   time. If the server is started from a different cwd than the one used during setup
   (systemd `WorkingDirectory`, `run.sh` `cd`, cron, manual `cd`), the vault silently
   resolves to a different — often empty or non-existent — directory. Every sync client
   (Obsidian plugin `pullAllFiles`, web client `/app` `loadFileTree`) then receives
   `{"files": [], "count": 0}` and the user sees "Loading… / vault is empty" forever.

2. **Orphaned uvicorn worker holds the port.** A uvicorn process started outside the
   service manager (e.g. a dev `uvicorn --reload` worker whose parent was killed) can
   survive with `PPID 1` and keep listening on `:8000`. The systemd unit then fails
   `address already in use` on every start and, with `Restart=always` + `RestartSec=5`,
   crash-loops indefinitely (observed restart counter 93+). The service never recovers
   on its own.

Observed on Linux (Fedora) with a user-scoped systemd unit. The same failure applies to
any deployment that runs one instance manually and another under a service manager.

## Environment

- Repo: https://github.com/ZenithFr/obsidian-api-sync @ main (a323d45)
- Server: FastAPI/uvicorn, Python 3.12, aiosqlite
- Deploy: user systemd unit, `ExecStart=.../uvicorn main:app --host 0.0.0.0 --port 8000`,
  `EnvironmentFile=server/.env`, `Restart=always`, `RestartSec=5`

## Symptoms

- Web client `/app` shows the file-tree "Loading…" spinner / empty vault; `GET /api/files`
  returns `count: 0` although the real vault has hundreds of notes.
- `systemctl status` shows `Active: activating (auto-restart)`; journal repeats:
  `ERROR: [Errno 98] error while attempting to bind on address ('0.0.0.0', 8000): address already in use`
- `ss -tlnp` shows the port owned by a uvicorn whose PPID is 1 (orphan), not the unit's Main PID.
- `tokens` table empty → WebSocket handshake closes 4001 → Obsidian plugin stuck reconnecting.

## Root Cause 1 — Relative vault path (code)

| Location | Issue |
|---|---|
| `server/config.py:44` | `DEFAULT_VAULT_PATH: str = "./vault"` — relative default |
| `server/config.py:43` | `DB_PATH: str = "./obsidian-sync.db"` — relative default (same class of bug for the DB file) |
| `server/database.py:88-91` | `init_db()` seeds `server_config.vault_path` with `settings.DEFAULT_VAULT_PATH` **verbatim** |
| `server/database.py:109-116` | `set_vault_path()` stores the dashboard-supplied path **verbatim** |
| `server/main.py:96-99` | lifespan calls `Path(vault_path).mkdir(...)` on the raw value → creates an empty dir in whatever cwd the process has |
| `server/routers/files.py:69` | `Path(vault_path).resolve()` — resolved against the **process cwd at request time** |
| `server/routers/ws.py:49-54,180-182` | same request-time cwd-dependent resolution |
| `server/main.py:75-90` | `_validate_vault_path` only blocks dangerous prefixes; relative paths pass through |

Consequence: `vault_path` is not stable across runs. In the observed incident the DB held
`./vault` which resolved to `<repo>/server/vault` (empty placeholder, 0 notes) while the
real vault lived elsewhere. The dashboard advertises "change the vault directory instantly"
— true for the stored value, but the *meaning* of a relative value silently changes with cwd.

## Root Cause 2 — Stray uvicorn / port collision (ops + code)

- `server/main.py:469-475` — `__main__` dev entrypoint runs `uvicorn.run(..., reload=True)`.
  The reloader spawns a worker; if the parent is SIGKILLed (dropped SSH/terminal), the
  worker survives with `PPID 1` and keeps the socket.
- No committed systemd unit in the repo; users assemble their own, commonly with
  `Restart=always` + `RestartSec=5`, which turns a bind failure into a permanent restart
  storm (≈720 failed starts/hour, unbounded journal growth).
- `run.sh:15` runs plain `uvicorn` in the foreground — safe, but nothing prevents a
  concurrent second instance from the dev path.

## Root Cause 3 — First-run auth gap (minor)

- `tokens` table starts empty; nothing seeds a token. The Obsidian plugin requires one but
  fails WS auth with a generic close code 4001, leaving users with an unactionable
  "Disconnected / Connecting…" state.

## Proposed fixes (priority order)

### P1 — Normalize vault path to absolute at write time (fixes Root Cause 1)

- `database.py:init_db()`: seed with `str(Path(settings.DEFAULT_VAULT_PATH).expanduser().resolve())`.
- `database.py:set_vault_path()`: store `str(Path(path).expanduser().resolve())` and return
  the normalized value to the caller (dashboard shows what was actually stored).
- `main.py:_validate_vault_path()`: after the dangerous-prefix check, expand and resolve,
  then re-check the prefix on the resolved path (defense against `..`-based escapes that
  resolve into `/etc` etc.).
- Optionally log a startup warning when the resolved vault contains 0 `*.md` files.
- Do the same normalization for `DB_PATH` in `config.py`/`database.py` (a relative DB path
  has the identical cwd-coupling problem).

### P2 — Ship a production service unit + guard against stray instances (fixes Root Cause 2)

- Add `deploy/obsidian-api-sync.service` example:
  - `WorkingDirectory=%h/obsidian-api-sync/server` (absolute, matches `run.sh`)
  - `Restart=on-failure`, `RestartSec=10`, `TimeoutStartSec=30`
  - `KillMode=mixed` (kill workers on stop)
  - comment: never combine with `--reload`
- In `main.py` dev entrypoint, make `reload=True` only when an explicit `DEV=1` env is set,
  or remove `reload` from the default and document `--reload` as dev-only.
- Optional: on startup, if the port is already bound, fail fast with a clear message
  (uvicorn already does this; the unit config is the actual fix).

### P3 — First-run token (fixes Root Cause 3)

- On first startup with an empty `tokens` table, generate a token and log the raw value
  once (stored hashed, as today), or show a prominent dashboard CTA. Update the plugin's
  settings screen to surface the 4001 auth failure as an actionable message.

## Reproduction

1. `cd server && python -c "import main"` or any run that seeds the DB while cwd = `server/`
   → `server_config.vault_path` becomes `./vault`.
2. Start the service from a different cwd (or systemd `WorkingDirectory` that differs from
   the setup dir) → `GET /api/files` resolves `./vault` against the new cwd → empty list
   even though the configured vault has notes.
3. Orphan test: start `uvicorn main:app --reload` in one terminal, `kill -9` the parent,
   start the systemd unit → unit fails `address already in use` forever.

## Verification

- After fix: `server_config.vault_path` is always an absolute path; starting the service
  from any cwd yields the same `GET /api/files` payload.
- `set_vault_path` round-trips a relative input like `../notes` to an absolute path and
  the dashboard displays the absolute value.
- With the shipped unit, killing the service and restarting never leaves a second listener;
  unit recovers with `on-failure` semantics instead of storming.
- Fresh install: user can authenticate (token exists) on first run without touching the DB.

## Out-of-scope notes

- The web client and plugin logic are fine; the failures are configuration/setup-path bugs.
- `DESIGN.md` and README "No vault path restart" claim is accurate only for absolute paths —
  worth a one-line doc clarification alongside the fix.

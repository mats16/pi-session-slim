# pi-session-zstd

A [pi](https://pi.dev) package that compresses old sessions with zstd and gives them back when you open them.

pi keeps every session as a plain `.jsonl` file under `~/.pi/agent/sessions/` and never shrinks it. This extension archives sessions that have been idle for a week, and restores a session just before pi reads it, so `/resume`, `pi -c`, `pi --session` and RPC `switch_session` work as before.

No dependencies and no external commands: it uses the zstd built into Node (`node:zlib`). It makes no network calls.

## Install

```sh
pi install git:github.com/mats16/pi-session-zstd
```

Needs Node 22.19 or later.

## How it works

An archived session is two files:

| File | Content |
|---|---|
| `<name>.jsonl.zst` | The full session, zstd level 9 with a 128 MB window |
| `<name>.jsonl` | A stub: a few lines copied verbatim from the session (header, first user message, last message, name, last line) |

pi lists only `.jsonl` files, so the stub keeps the session in `/resume` with its name, first message and date. Its modification time is the original's.

**Archiving.** Five seconds after pi starts, the extension archives every session under `~/.pi/agent/sessions/` (and the current session directory, if it is elsewhere) that has not been modified for 7 days and is at least 64 KB. It skips the session you have open. Before it replaces a session with its stub, it decompresses the archive and compares its SHA-256 with the original. One pi process archives at a time, and a full pass runs at most every 6 hours.

**Restoring.** A session is restored when:

- you pick it in `/resume`, or a client sends RPC `switch_session` (`session_before_switch`);
- pi starts on it (`pi -c`, `pi --session`, `pi -r`). pi has read the stub by then, so the extension restores the file and opens the session again before the first prompt.

Restoring writes the full session back and deletes the `.zst`. Lines that are in the `.jsonl` but not in the archive are kept at the end, so anything pi appended to a stub survives.

## Commands

| Command | What it does |
|---|---|
| `/session-zstd` | Show how many sessions are archived and their size |
| `/session-zstd run [days]` | Archive now. `days` defaults to the automatic setting; `0` archives everything but the open session |
| `/session-zstd restore` | Restore every archived session (do this before you uninstall) |

## Settings

| Environment variable | Default | Meaning |
|---|---|---|
| `PI_SESSION_ZSTD_DAYS` | `7` | Archive sessions idle for this many days. `0` turns automatic archiving off; the command and restoring still work |

## What to expect

- **Size.** Text compresses to about 0.13 of its size. Images that tools returned are stored as base64 and compress only to about 0.6, so a session directory that is mostly screenshots shrinks by 40%, not 90%. The 128 MB window removes an image that was read twice in one session.
- **Speed.** A 103 MB session takes 1.2 s to archive and 0.4 s to restore (Apple M-series).

## Limits

- **Other tools see the stub.** Anything that reads `.jsonl` files itself (usage reports, search scripts) sees a few lines for an archived session. Read the archive with `zstd -dc <name>.jsonl.zst`.
- **`/resume` search** matches only the first and last message of an archived session, and its message count shows 1 or 2.
- **`pi --fork <archived session>`** copies the stub. Open the session once, or run `/session-zstd restore`, before you fork it from the command line. `/fork` inside a session is fine.
- **Deleting an archived session** in `/resume` removes the stub; delete the `.jsonl.zst` next to it yourself.
- **A session another pi process still has open** can be archived if it has been idle for the full period. What that process writes later goes to the stub and is merged back on restore, but until then that process works from the history it has in memory.
- Age is the file's modification time.

## Development

```sh
node --test
```

Inspired by [pi-session-kit](https://github.com/yaroshevych/pi-session-kit), which archives sessions to `.zip` and restores them by hand.

## License

MIT

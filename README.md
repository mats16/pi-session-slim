# pi-session-slim

A [pi](https://pi.dev) package that keeps session files small.

pi keeps every session as a plain `.jsonl` file under `~/.pi/agent/sessions/` and never shrinks it. Most of that space is images: every screenshot a tool returns is stored as base64 PNG. This extension does two things:

1. **Images become WebP when they enter the session.** A PNG that a tool returns is converted to lossy WebP before pi stores it or sends it to a model.
2. **Old sessions are compressed with zstd.** Sessions idle for a week are archived, and restored just before pi reads them, so `/resume`, `pi -c`, `pi --session` and RPC `switch_session` work as before.

It uses the zstd built into Node (`node:zlib`) and a WebAssembly build of libwebp ([jSquash](https://github.com/jamsinclair/jSquash)). No native binaries, no external commands, no network calls.

## Install

```sh
pi install git:github.com/mats16/pi-session-slim
```

Needs Node 22.19 or later.

## Images

When a tool result contains a PNG, the extension replaces it with WebP of quality 80. The session file and every later request carry the WebP.

- **This is lossy and cannot be undone.** The model sees the WebP, not the PNG. Text in a 1600×900 slide stays readable at quality 80. Set `PI_SESSION_SLIM_WEBP=0` to keep images as they are.
- PNGs under 3 KB, PNGs that fail to decode, and images that are not smaller as WebP are left alone. JPEG and WebP are never touched.
- Conversion runs in a worker thread and takes about 0.1 s for a 1600×900 image.
- Images you paste into the prompt are not converted, only tool results.
- Your models must accept WebP. Claude, GPT, Gemini, Grok, Kimi and GLM did when tested through one gateway in November 2026.

## Archiving

An archived session is two files:

| File | Content |
|---|---|
| `<name>.jsonl.zst` | The full session, zstd level 9 |
| `<name>.jsonl` | A stub: a few lines copied verbatim from the session (header, first user message, last message, name, last line) |

pi lists only `.jsonl` files, so the stub keeps the session in `/resume` with its name, first message and date. Its modification time is the original's.

**When.** Five seconds after pi starts, the extension archives every session under `~/.pi/agent/sessions/` (and the current session directory, if it is elsewhere) that has not been modified for 7 days and is at least 64 KB. It skips the session you have open. One pi process archives at a time, and a full pass runs at most every 6 hours. When a pass archives something or hits an error, pi shows a notice with the count, the space saved, and any PNGs that could not be converted (those stay PNG).

**Images in old sessions.** PNG image blocks in user, assistant and tool-result messages are converted to WebP before compression, unless `PI_SESSION_SLIM_WEBP=0`. Custom entries and opaque extension data are kept unchanged. Lines whose JSON formatting differs from pi’s serialization are also kept unchanged. Images convert in up to four worker threads (one CPU core is left for pi). The first pass over a large backlog is still slow: about 0.04 s per image on an Apple M-series machine. Workers idle for a minute exit and give their memory back.

**Checks before the original is replaced.** The archive is decompressed and its SHA-256 compared with what was compressed. When images were converted, the session with its image bytes removed must be identical before and after, and every WebP must decode to the PNG's width and height.

**Restoring.** A session is restored when:

- you pick it in `/resume`, or a client sends RPC `switch_session` (`session_before_switch`);
- pi starts on it (`pi -c`, `pi --session`, `pi -r`). pi has read the stub by then, so the extension restores the file and opens the session again before the first prompt.

Restoring writes the full session back and deletes the `.zst`. Lines that are in the `.jsonl` but not in the archive are kept at the end, so anything pi appended to a stub survives.

## Commands

| Command | What it does |
|---|---|
| `/session-slim` | Show how many sessions are archived and their size, archives whose session was deleted, and PNGs that could not be converted since pi started |
| `/session-slim run [days]` | Archive now. `days` defaults to the automatic setting; `0` archives everything but the open session |
| `/session-slim restore` | Restore every archived session (do this before you uninstall). Converted images stay WebP |

## Settings

| Environment variable | Default | Meaning |
|---|---|---|
| `PI_SESSION_SLIM_WEBP` | `80` | WebP quality, 1 to 100. `0` keeps images as they are, in tool results and in archives |
| `PI_SESSION_SLIM_DAYS` | `7` | Archive sessions idle for this many days. `0` turns automatic archiving off; the command and restoring still work |

If `PI_SESSION_SLIM_DAYS` is unset, the legacy `PI_SESSION_ZSTD_DAYS` value is used, including `0` to keep automatic archiving off. The new variable takes precedence when both are set.

## What to expect

Measured on one real 103 MB session with 145 PNG screenshots (Apple M-series):

| | Archive size | Time to archive | Time to restore | Size after restore |
|---|---:|---:|---:|---:|
| zstd only (`PI_SESSION_SLIM_WEBP=0`) | 59 MB | 1.2 s | 0.4 s | 103 MB |
| WebP, then zstd | 23 MB | 6 s | 0.2 s | 51 MB |

Text compresses to about 0.13 of its size. Base64 images compress only to about 0.6 with zstd, which is why converting them matters; a PNG slide becomes about 0.27 of its size as WebP.

## Limits

- **Other tools see the stub.** Anything that reads `.jsonl` files itself (usage reports, search scripts) sees a few lines for an archived session. Read the archive with `zstd -dc <name>.jsonl.zst`.
- **`/resume` search** matches only the first and last message of an archived session, and its message count shows 1 or 2.
- **`pi --fork <archived session>`** copies the stub. Open the session once, or run `/session-slim restore`, before you fork it from the command line. `/fork` inside a session is fine.
- **Deleting an archived session** in `/resume` removes the stub; delete the `.jsonl.zst` next to it yourself. `/session-slim` counts these leftover archives.
- **A session another pi process still has open** can be archived if it has been idle for the full period. What that process writes later goes to the stub and is merged back on restore, but until then that process works from the history it has in memory.
- Text that mentions the format (`Read image file [image/png]`) is not rewritten when the image is.
- Age is the file's modification time.

## Development

```sh
npm install
node --test
```

Inspired by [pi-session-kit](https://github.com/yaroshevych/pi-session-kit), which archives sessions to `.zip` and restores them by hand.

## License

MIT

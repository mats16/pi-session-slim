/**
 * pi-session-slim: keep pi's session files small.
 *
 * 1. PNG images that tools return become lossy WebP before pi stores them or sends them to a model.
 * 2. Sessions idle for a week are compressed with zstd (their remaining PNGs become WebP first)
 *    and brought back when they are opened.
 *
 * An archived session is two files:
 *   <name>.jsonl.zst  the full session, zstd
 *   <name>.jsonl      a stub: a few lines copied verbatim from the session (header, first user
 *                     message, last message, name, last line) so pi still lists it in /resume
 * A .jsonl with a .jsonl.zst next to it is archived. Restoring writes the full session back and
 * removes the .zst. Lines found in the .jsonl but not in the archive (pi appended to a stub) are
 * kept at the end, so restoring never drops data.
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import * as zlib from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STUB_LINE_MAX = 16 * 1024; // longer lines (pasted images) stay out of the stub
const MIN_SIZE = 64 * 1024; // smaller files save nothing once the stub is written
const MIN_IMAGE = 4096; // base64 characters; icons this small gain nothing
const TMP = /\.jsonl(\.zst|\.slim)?\.\d+\.tmp$/;
// How pi serializes an image block. Only PNG is converted; WebP is matched so that skeleton() can
// compare a session before and after conversion.
const IMAGE = /"data":"([A-Za-z0-9+/=]+)","mimeType":"image\/(png|webp)"/g;

export const zstOf = (file: string) => `${file}.zst`;
export const isArchived = (file: string) => existsSync(zstOf(file));

const lines = (file: string) => createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });

/** The line without its image bytes: equal before and after WebP conversion, different for any other change. */
const skeleton = (line: string) =>
	line.includes('"mimeType":"image/') ? line.replace(IMAGE, '"data":"","mimeType":"image"') : line;

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve: (data: string) => void; reject: (error: Error) => void }>();

/** base64 PNG to base64 WebP, in a worker thread (see webp.mjs). */
export function toWebp(data: string, quality: number): Promise<string> {
	if (!worker) {
		worker = new Worker(new URL("./webp.mjs", import.meta.url));
		const settle = (id: number) => {
			const entry = waiting.get(id);
			waiting.delete(id);
			if (waiting.size === 0) worker?.unref(); // an idle worker must not keep pi alive
			return entry;
		};
		worker.on("message", ({ id, data, error }) => {
			const entry = settle(id);
			if (error) entry?.reject(new Error(error));
			else entry?.resolve(data);
		});
		worker.on("error", (error) => {
			for (const id of [...waiting.keys()]) settle(id)?.reject(error);
			worker = undefined;
		});
	}
	const w = worker;
	return new Promise((resolve, reject) => {
		waiting.set(nextId, { resolve, reject });
		w.ref();
		w.postMessage({ id: nextId++, data, quality });
	});
}

/** The WebP for a PNG, or undefined when it should stay as it is (tiny, unreadable, or no smaller as WebP). */
async function smaller(png: string, quality: number): Promise<string | undefined> {
	if (png.length < MIN_IMAGE) return undefined;
	const webp = await toWebp(png, quality).catch(() => undefined);
	return webp && webp.length < png.length ? webp : undefined;
}

/** A session line with its PNG images as WebP. Every other byte stays. */
async function slimLine(line: string, quality: number): Promise<string> {
	if (!line.includes('"mimeType":"image/png"')) return line;
	const parts: string[] = [];
	let at = 0;
	for (const m of line.matchAll(IMAGE)) {
		const webp = m[2] === "png" ? await smaller(m[1], quality) : undefined;
		if (!webp) continue;
		parts.push(line.slice(at, m.index), `"data":"${webp}","mimeType":"image/webp"`);
		at = m.index + m[0].length;
	}
	return parts.join("") + line.slice(at);
}

/**
 * The lines pi needs to list the session: header, first user message, last message, latest name.
 * The session's last line always ends the stub, whatever its size: pi appends to a stub it opened
 * before this extension loaded (a thinking_level_change at startup), and chains the new entry to
 * the last one in the file. With any other line there, the restored session would continue from
 * the middle of its history.
 */
async function buildStub(file: string): Promise<string> {
	let header: string | undefined;
	let first: string | undefined;
	let last: string | undefined;
	let name: string | undefined;
	let tail: string | undefined;
	for await (const line of lines(file)) {
		if (!line) continue;
		tail = line;
		if (header === undefined) {
			if (JSON.parse(line).type !== "session") throw new Error("not a pi session");
			header = line;
			continue;
		}
		if (line.length > STUB_LINE_MAX) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session_info") name = line;
		const role = entry.type === "message" ? entry.message?.role : undefined;
		if (role === "user") first ??= line;
		if (role === "user" || role === "assistant") last = line;
	}
	if (header === undefined) throw new Error("empty session");
	const kept = new Set([header, first, last, name]);
	kept.delete(tail); // moves it to the end
	kept.add(tail);
	return [...kept].filter((l) => l !== undefined).join("\n") + "\n";
}

async function sha256(source: AsyncIterable<Buffer>) {
	const hash = createHash("sha256");
	for await (const chunk of source) hash.update(chunk);
	return hash.digest("hex");
}

async function skeletonHash(file: string) {
	const hash = createHash("sha256");
	for await (const line of lines(file)) hash.update(`${skeleton(line)}\n`);
	return hash.digest("hex");
}

/**
 * Compress `file` to `file.zst` and leave a stub. With `quality` above 0, PNG images become WebP
 * of that quality first, which cannot be undone. Returns the bytes saved (0 when already archived).
 */
export async function archive(file: string, quality = 0): Promise<number> {
	const zst = zstOf(file);
	if (existsSync(zst)) return 0;
	const before = statSync(file);
	const tmp = `${zst}.${process.pid}.tmp`;
	const stubTmp = `${file}.${process.pid}.tmp`;
	const slimTmp = `${file}.slim.${process.pid}.tmp`;
	try {
		let source = file;
		if (quality > 0) {
			let changed = false;
			await pipeline(
				lines(file),
				async function* (source) {
					for await (const line of source) {
						const slim = await slimLine(line, quality);
						changed ||= slim !== line;
						yield `${slim}\n`;
					}
				},
				createWriteStream(slimTmp, { mode: 0o600 }),
			);
			if (changed) {
				// The images are lossy now, so the bytes cannot match. Everything else must.
				if ((await skeletonHash(file)) !== (await skeletonHash(slimTmp))) {
					throw new Error("WebP conversion changed more than the images");
				}
				source = slimTmp;
			}
		}

		const compress = zlib.createZstdCompress({
			params: {
				[zlib.constants.ZSTD_c_compressionLevel]: 9, // 19 is 30x slower for under 1% on real sessions
				// Long-range matching over 128 MB, the largest window a default decoder
				// (`zstd -d`, node) accepts. Sessions repeat prompts and tool output far apart.
				[zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
				[zlib.constants.ZSTD_c_windowLog]: 27,
			},
		});
		await pipeline(createReadStream(source), compress, createWriteStream(tmp, { mode: 0o600 }));

		// The original is deleted below, so prove the archive gives it back first.
		const [original, roundTrip] = await Promise.all([
			sha256(createReadStream(source)),
			pipeline(createReadStream(tmp), zlib.createZstdDecompress(), sha256),
		]);
		if (original !== roundTrip) throw new Error("archive does not match the session");

		const stub = await buildStub(source);
		const now = statSync(file);
		if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) throw new Error("session changed while archiving");
		// shortcut: a line pi appends between this check and the rename below is lost. Candidates
		// are days old, so the window is microseconds on an idle file; take a lock if that changes.
		writeFileSync(stubTmp, stub, { mode: before.mode & 0o777 });
		utimesSync(stubTmp, before.atime, before.mtime); // keep the age pi sorts by with -c
		renameSync(tmp, zst);
		renameSync(stubTmp, file);
		return before.size - statSync(zst).size - Buffer.byteLength(stub);
	} finally {
		for (const f of [tmp, stubTmp, slimTmp]) rmSync(f, { force: true });
	}
}

/** Write the full session back over the stub. Returns false when `file` is not archived. */
export async function restore(file: string): Promise<boolean> {
	const zst = zstOf(file);
	if (!existsSync(zst)) return false;
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
		await pipeline(createReadStream(zst), zlib.createZstdDecompress(), createWriteStream(tmp, { mode }));

		// Keep what was written to the .jsonl after it was archived. Lines are matched without their
		// image bytes: after a crash between archive()'s two renames the .jsonl still holds the PNGs
		// that the archive holds as WebP, and those are the same lines.
		const extra = new Map<string, string>();
		if (existsSync(file)) for await (const line of lines(file)) if (line) extra.set(skeleton(line), line);
		for await (const line of lines(tmp)) {
			extra.delete(skeleton(line));
			if (extra.size === 0) break;
		}
		if (extra.size > 0) {
			const size = statSync(tmp).size;
			const tail = Buffer.alloc(1);
			const fd = openSync(tmp, "r");
			try {
				if (size > 0) readSync(fd, tail, 0, 1, size - 1);
			} finally {
				closeSync(fd);
			}
			appendFileSync(tmp, (size > 0 && tail[0] !== 10 ? "\n" : "") + [...extra.values()].join("\n") + "\n");
		}
		renameSync(tmp, file);
		rmSync(zst, { force: true });
		return true;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Every regular file under `roots`, recursively. Does not follow symlinks. */
function walk(roots: string[]): string[] {
	const out = new Set<string>();
	for (const root of roots) {
		let entries;
		try {
			entries = readdirSync(root, { recursive: true, withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) if (e.isFile()) out.add(join(e.parentPath, e.name));
	}
	return [...out];
}

export interface RunResult {
	files: number;
	saved: number;
	errors: string[];
}

/** Archive sessions under `roots` not modified for `days`, except `skip`. */
export async function archiveOld(
	roots: string[],
	days: number,
	opts: { skip?: string; quality?: number; signal?: AbortSignal; onFile?: () => void } = {},
): Promise<RunResult> {
	const cutoff = Date.now() - days * 86_400_000;
	const result: RunResult = { files: 0, saved: 0, errors: [] };
	for (const file of walk(roots)) {
		if (opts.signal?.aborted) break;
		try {
			const st = lstatSync(file);
			if (TMP.test(file)) {
				if (st.mtimeMs < Date.now() - 86_400_000) rmSync(file, { force: true }); // left by a killed run
				continue;
			}
			if (!file.endsWith(".jsonl") || file === opts.skip || st.size < MIN_SIZE || st.mtimeMs > cutoff) continue;
			if (isArchived(file)) continue;
			result.saved += await archive(file, opts.quality);
			result.files++;
			opts.onFile?.();
		} catch (error) {
			result.errors.push(`${file}: ${(error as Error).message}`);
		}
	}
	return result;
}

/** Restore every archived session under `roots`. */
export async function restoreAll(roots: string[]): Promise<RunResult> {
	const result: RunResult = { files: 0, saved: 0, errors: [] };
	for (const zst of walk(roots)) {
		if (!zst.endsWith(".jsonl.zst")) continue;
		try {
			if (await restore(zst.slice(0, -4))) result.files++;
		} catch (error) {
			result.errors.push(`${zst}: ${(error as Error).message}`);
		}
	}
	return result;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

export default function sessionSlim(pi: ExtensionAPI) {
	if (typeof zlib.createZstdCompress !== "function") {
		pi.on("session_start", (_e, ctx) => ctx.ui.notify("pi-session-slim needs Node 22.19 or later; doing nothing.", "warning"));
		return;
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const lock = join(agentDir, "session-slim.lock");
	const done = join(agentDir, "session-slim.done");
	const envDays = Number(process.env.PI_SESSION_SLIM_DAYS ?? 7); // 0 or not a number: no automatic run
	const envQuality = Number(process.env.PI_SESSION_SLIM_WEBP ?? 80);
	const quality = envQuality > 0 && envQuality <= 100 ? envQuality : 0; // 0: images stay as they are
	const roots = (ctx: { sessionManager: { getSessionDir(): string } }) => [
		join(agentDir, "sessions"),
		ctx.sessionManager.getSessionDir(), // --session-dir, PI_CODING_AGENT_SESSION_DIR, settings
	];
	const age = (file: string) => {
		try {
			return Date.now() - statSync(file).mtimeMs;
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	};

	let abort: AbortController | undefined;
	let timer: NodeJS.Timeout | undefined;
	let reloaded: (() => void) | undefined;

	/** One run at a time across pi processes. The lock is touched per file; 10 quiet minutes means its owner died. */
	async function run(ctx: Parameters<typeof roots>[0], days: number, skip?: string): Promise<RunResult | undefined> {
		if (age(lock) < 600_000) return undefined;
		rmSync(lock, { force: true });
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
		} catch {
			return undefined; // another process took it first
		}
		abort = new AbortController();
		try {
			const result = await archiveOld(roots(ctx), days, {
				skip,
				quality,
				signal: abort.signal,
				onFile: () => utimesSync(lock, new Date(), new Date()),
			});
			if (!abort.signal.aborted) writeFileSync(done, "");
			return result;
		} finally {
			rmSync(lock, { force: true });
		}
	}

	// Images enter a session here, so this is where they are cheapest to shrink: the session file
	// and every later request carry the WebP, and the prompt cache never sees the PNG.
	if (quality > 0) {
		pi.on("tool_result", async (event) => {
			let changed = false;
			const content = await Promise.all(
				event.content.map(async (block) => {
					if (block.type !== "image" || block.mimeType !== "image/png") return block;
					const data = await smaller(block.data, quality);
					if (!data) return block;
					changed = true;
					return { ...block, data, mimeType: "image/webp" };
				}),
			);
			// pi drops structuredContent when content is replaced without it.
			if (changed) return { content, structuredContent: event.structuredContent };
		});
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		const file = ctx.sessionManager.getSessionFile();
		// pi read the stub before extensions loaded (pi -c, --session, -r). Open the session again;
		// session_before_switch below restores it first.
		// Startup waits here until the reload is over, so the first prompt (pi -p) cannot reach the stub.
		if (file && isArchived(file)) {
			await new Promise<void>((done) => {
				reloaded = done;
				pi.sendUserMessage("/session-slim reload", { expandPromptTemplates: true });
				setTimeout(done, 60_000).unref(); // the command never ran: go on rather than hang pi
			});
		}

		if (!(envDays > 0) || age(done) < 6 * 3_600_000) return;
		// Wait until startup is over, and never keep pi alive for this.
		timer = setTimeout(() => {
			run(ctx, envDays, file).catch(() => {});
		}, 5_000);
		timer.unref();
	});

	pi.on("session_before_switch", async (event, ctx) => {
		if (!event.targetSessionFile) return;
		try {
			await restore(resolve(event.targetSessionFile));
		} catch (error) {
			// Opening the stub would continue a conversation without its history.
			ctx.ui.notify(`pi-session-slim: could not restore the session: ${(error as Error).message}`, "error");
			return { cancel: true };
		}
	});

	pi.on("session_shutdown", () => {
		clearTimeout(timer);
		abort?.abort(); // stops after the file in progress
	});

	pi.registerCommand("session-slim", {
		description: "Compress old sessions with zstd: status | run [days] | restore",
		handler: async (args, ctx) => {
			const [sub, arg] = (args.trim() || "status").split(/\s+/);
			const current = ctx.sessionManager.getSessionFile();
			if (sub === "reload") {
				try {
					if (current) await ctx.switchSession(current);
				} finally {
					reloaded?.();
				}
				return;
			}
			const report = (verb: string, r: RunResult) =>
				ctx.ui.notify(
					`${verb} ${r.files} session(s)${r.saved ? `, saved ${mb(r.saved)}` : ""}` +
						(r.errors.length ? `\n${r.errors.length} failed:\n${r.errors.slice(0, 5).join("\n")}` : ""),
					r.errors.length ? "warning" : "info",
				);
			if (sub === "run") {
				const days = arg === undefined ? envDays || 7 : Number(arg);
				if (!(days >= 0)) return ctx.ui.notify("Usage: /session-slim run [days]", "error");
				const result = await run(ctx, days, current);
				if (!result) return ctx.ui.notify("Another pi is archiving sessions right now.", "warning");
				return report("Archived", result);
			}
			if (sub === "restore") return report("Restored", await restoreAll(roots(ctx)));
			if (sub !== "status") return ctx.ui.notify("Usage: /session-slim [status | run [days] | restore]", "error");
			let archived = 0;
			let archivedBytes = 0;
			let plain = 0;
			let plainBytes = 0;
			for (const file of walk(roots(ctx))) {
				if (file.endsWith(".jsonl.zst")) {
					archived++;
					archivedBytes += statSync(file).size;
				} else if (file.endsWith(".jsonl") && !isArchived(file)) {
					plain++;
					plainBytes += statSync(file).size;
				}
			}
			ctx.ui.notify(
				`Archived: ${archived} session(s), ${mb(archivedBytes)} on disk\n` +
					`Not archived: ${plain} session(s), ${mb(plainBytes)}\n` +
					(envDays > 0 ? `Sessions idle for ${envDays} day(s) are archived automatically.` : "Automatic archiving is off.") +
					`\n${quality > 0 ? `PNG images become WebP (quality ${quality}).` : "Images are kept as they are."}`,
				"info",
			);
		},
	});
}

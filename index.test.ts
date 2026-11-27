import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import sessionSlim, { archive, archiveOld, isArchived, restore, restoreAll, toWebp, zstOf } from "./index.ts";

const line = (o: unknown) => JSON.stringify(o);
const msg = (id: string, parentId: string | null, role: string, text: string) =>
	line({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role, content: [{ type: "text", text }] } });

/** A 64x64 RGBA PNG as base64: large enough to convert, and smaller as WebP. */
function png() {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(64, 0);
	header.writeUInt32BE(64, 4);
	header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
	const rows = Buffer.alloc(64 * (1 + 64 * 4));
	// A gradient with noise in the low bits: deflate cannot pack it, lossy WebP smooths it away.
	for (let i = 0; i < rows.length; i++) rows[i] = i % 257 === 0 ? 0 : ((i % 257) >> 1) + (((i * 2654435761) >>> 24) & 7); // filter byte 0 per row
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function session(dir = mkdtempSync(join(tmpdir(), "psz-"))) {
	const file = join(dir, "2026-01-01T00-00-00-000Z_abc.jsonl");
	const body = [
		line({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		msg("a1", null, "user", "hello"),
		msg("a2", "a1", "toolResult", "x".repeat(200_000)), // too long for the stub
		line({ type: "session_info", id: "a3", parentId: "a2", timestamp: "2026-01-01T00:00:00.000Z", name: "my session" }),
		msg("a4", "a3", "assistant", "bye"),
		msg("a5", "a4", "toolResult", "y".repeat(20_000)), // too long too, but it is the leaf
	];
	writeFileSync(file, body.join("\n") + "\n");
	const old = new Date(Date.now() - 30 * 86_400_000);
	utimesSync(file, old, old);
	return { dir, file, body, text: readFileSync(file, "utf8"), old };
}

test("archive leaves a listable stub and restore gives back the same bytes", async () => {
	const { file, body, text, old } = session();
	const saved = await archive(file);
	assert.ok(saved > 100_000);
	assert.ok(isArchived(file));
	// The leaf is last: pi chains what it appends to a stub to the last entry in the file.
	assert.equal(readFileSync(file, "utf8"), [body[0], body[1], body[4], body[3], body[5]].join("\n") + "\n");
	assert.equal(statSync(file).mtimeMs, old.getTime());
	assert.equal(await archive(file), 0); // already archived: the stub is not archived again

	assert.equal(await restore(file), true);
	assert.equal(readFileSync(file, "utf8"), text);
	assert.ok(!existsSync(zstOf(file)));
	assert.equal(await restore(file), false);
});

test("restore keeps lines appended to the stub", async () => {
	const { file, text } = session();
	await archive(file);
	const added = msg("b1", "a5", "user", "written to the stub");
	appendFileSync(file, added + "\n");
	await restore(file);
	assert.equal(readFileSync(file, "utf8"), text + added + "\n");
});

test("restore is safe when the full file is still there (crash between the two renames)", async () => {
	const { file, text } = session();
	await archive(file);
	writeFileSync(file, text);
	await restore(file);
	assert.equal(readFileSync(file, "utf8"), text);
});

test("a file that is not a pi session is left alone", async () => {
	const { file } = session();
	const text = "x".repeat(100_000) + "\n";
	writeFileSync(file, text);
	await assert.rejects(archive(file));
	assert.equal(readFileSync(file, "utf8"), text);
	assert.ok(!existsSync(zstOf(file)));
});

test("archiveOld takes only old sessions, skips the current one, and restoreAll undoes it", async () => {
	const a = session();
	const fresh = join(a.dir, "fresh.jsonl");
	writeFileSync(fresh, a.text);
	const current = join(a.dir, "current.jsonl");
	writeFileSync(current, a.text);
	utimesSync(current, a.old, a.old);

	const result = await archiveOld([a.dir, a.dir], 7, { skip: current });
	assert.deepEqual([result.files, result.errors], [1, []]);
	assert.ok(isArchived(a.file) && !isArchived(fresh) && !isArchived(current));
	assert.equal((await restoreAll([a.dir])).files, 1);
	assert.equal(readFileSync(a.file, "utf8"), a.text);
});

test("archive with a quality turns PNG into WebP and changes nothing else", async () => {
	const { dir } = session();
	const file = join(dir, "images.jsonl");
	const image = (data: string, mimeType: string) =>
		line({ type: "message", id: "i1", parentId: "a1", message: { role: "toolResult", content: [{ type: "text", text: "Read [image/png]" }, { type: "image", data, mimeType }] } });
	const data = png();
	const webp = await toWebp(data, 80);
	assert.ok(webp.length < data.length && Buffer.from(webp, "base64").subarray(8, 12).toString() === "WEBP");
	const head = line({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
	const pad = msg("a1", null, "user", "x".repeat(70_000));
	const tiny = image("iVBORw0KGgo=", "image/png"); // under the size worth converting
	const end = msg("a2", "i1", "assistant", "done");
	const text = [head, pad, image(data, "image/png"), tiny, end].join("\n") + "\n";
	writeFileSync(file, text);

	await archive(file, 80);
	writeFileSync(file, text); // as if pi died between the two renames: the PNG file is still there
	await restore(file);
	// One copy of each line, the PNG now WebP: the leftover PNG lines were not appended as new ones.
	assert.equal(readFileSync(file, "utf8"), [head, pad, image(webp, "image/webp"), tiny, end].join("\n") + "\n");
});

test("archiveOld counts PNGs it cannot convert, keeps them, and keeps line order while converting in parallel", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psz-"));
	const file = join(dir, "images.jsonl");
	const image = (id: string, data: string, mimeType: string) =>
		line({ type: "message", id, parentId: "a1", message: { role: "toolResult", content: [{ type: "image", data, mimeType }] } });
	const data = png();
	const webp = await toWebp(data, 80);
	const broken = image("bad", "iVBORw0KGgo" + "A".repeat(5000), "image/png"); // a PNG signature, then garbage
	const head = line({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
	const pad = msg("a1", null, "user", "x".repeat(70_000));
	const ids = Array.from({ length: 12 }, (_, i) => `i${i}`);
	const before = [head, pad, ...ids.map((id) => image(id, data, "image/png")), broken, msg("z", "bad", "assistant", "end")];
	const after = [head, pad, ...ids.map((id) => image(id, webp, "image/webp")), broken, msg("z", "bad", "assistant", "end")];
	writeFileSync(file, before.join("\n") + "\n");
	const old = new Date(Date.now() - 30 * 86_400_000);
	utimesSync(file, old, old);

	const result = await archiveOld([dir], 7, { quality: 80 });
	assert.deepEqual([result.files, result.errors, result.imageErrors], [1, [], 1]);
	await restore(file);
	assert.equal(readFileSync(file, "utf8"), after.join("\n") + "\n");
});

test("status lists archives whose session was deleted", async () => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	try {
		const { dir, file } = session();
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "slim-status-"));
		await archive(file);
		rmSync(file); // what deleting it in /resume does
		let handler: any;
		const notices: string[] = [];
		sessionSlim({ on() {}, registerCommand(_name: string, command: any) { handler = command.handler; } } as any);
		await handler("status", { sessionManager: { getSessionFile() {}, getSessionDir() { return dir; } }, ui: { notify(text: string) { notices.push(text); } } });
		assert.match(notices[0], /Archives without a session: 1,/);
		assert.ok(existsSync(zstOf(file))); // reported, not removed
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
});

test("conversion output errors reject without crashing pi or replacing the original", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
	const { dir, file, text } = session();
	chmodSync(dir, 0o500);
	try {
		const script = `
			import { archive, archiveOld } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
			import assert from "node:assert/strict";
			await assert.rejects(archive(${JSON.stringify(file)}, 80), { code: "EACCES" });
			const result = await archiveOld([${JSON.stringify(dir)}], 7, { quality: 80 });
			assert.equal(result.files, 0);
			assert.equal(result.errors.length, 1);
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(file, "utf8"), text);
		assert.ok(!existsSync(zstOf(file)));
	} finally {
		chmodSync(dir, 0o700);
	}
	await archive(file, 80);
	await restore(file);
	assert.equal(readFileSync(file, "utf8"), text);
});


test("archive and recovery preserve opaque PNG payloads outside message images", async () => {
	const { file, body } = session();
	const data = png();
	const webp = await toWebp(data, 80);
	const opaque = { data, mimeType: "image/png" };
	const custom = line({ type: "custom", id: "custom", customType: "example", data: opaque });
	const changedCustom = line({ type: "custom", id: "custom", customType: "example", data: { data: webp, mimeType: "image/webp" } });
	const message = (data: string, mimeType: string) => line({
		type: "message", id: "image", parentId: "a5",
		message: { role: "toolResult", content: [
			{ type: "image", data, mimeType, metadata: opaque },
			{ type: "text", text: "keep", metadata: opaque },
		], details: opaque, structuredContent: opaque },
	});
	const call = line({ type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", arguments: opaque }] } });
	const formatted = " " + message(data, "image/png");
	const before = [...body, custom, message(data, "image/png"), call, formatted].join("\n") + "\n";
	const after = [...body, custom, message(webp, "image/webp"), call, formatted].join("\n") + "\n";
	writeFileSync(file, before);
	await archive(file, 80);
	// Recover the old full PNG file plus an opaque update, as after an interrupted archive.
	writeFileSync(file, before + changedCustom + "\n");
	await restore(file);
	assert.equal(readFileSync(file, "utf8"), after + changedCustom + "\n");
});

test("renamed archive setting preserves legacy values and explicit new overrides", async () => {
	const keys = ["PI_CODING_AGENT_DIR", "PI_SESSION_ZSTD_DAYS", "PI_SESSION_SLIM_DAYS"];
	const saved = keys.map((key) => process.env[key]);
	try {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "slim-settings-"));
		for (const [legacy, current, expected] of [
			["0", undefined, 0], ["3", undefined, 3], ["0", "2", 2], ["3", "0", 0], [undefined, undefined, 7],
		] as const) {
			for (const [key, value] of [["PI_SESSION_ZSTD_DAYS", legacy], ["PI_SESSION_SLIM_DAYS", current]]) {
				if (value === undefined) delete process.env[key!];
				else process.env[key!] = value;
			}
			let handler: any;
			const notices: string[] = [];
			sessionSlim({ on() {}, registerCommand(_name: string, command: any) { handler = command.handler; } } as any);
			await handler("status", { sessionManager: { getSessionFile() {}, getSessionDir() { return process.env.PI_CODING_AGENT_DIR; } }, ui: { notify(text: string) { notices.push(text); } } });
			assert.ok(notices[0].includes(expected === 0 ? "Automatic archiving is off." : `Sessions idle for ${expected} day(s)`), `${legacy}/${current}: ${notices[0]}`);
		}
	} finally {
		keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
	}
});

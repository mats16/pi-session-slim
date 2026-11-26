import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archive, archiveOld, isArchived, restore, restoreAll, zstOf } from "./index.ts";

const line = (o: unknown) => JSON.stringify(o);
const msg = (id: string, parentId: string | null, role: string, text: string) =>
	line({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role, content: [{ type: "text", text }] } });

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

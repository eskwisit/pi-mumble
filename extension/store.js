// Mumble: keeps the exact original of each shrunk tool result, so the agent can get it back.
// No original on disk, no shrinking.
// Credit: this recovery contract follows the CCR store of https://github.com/JuliusBrussee/caveman (Apache-2.0, Copyright 2026 Julius Brussee). See NOTICE.
//
// Files live in the temporary folder of the operating system, one folder per session, readable
// only by the user. The folder is removed when the session ends. Folders older than one day are
// removed at the next session start.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.join(os.tmpdir(), "pi-mumble");
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_RETRIEVE_CHARS = 40000;
const ID = /^[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function sweep(root = ROOT, now = Date.now()) {
	let names = [];
	try {
		names = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		const dir = path.join(root, name);
		try {
			if (now - fs.statSync(dir).mtimeMs > DAY_MS) fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

export function createStore(root = ROOT) {
	const dir = path.join(root, crypto.randomUUID());
	let bytes = 0;
	let ready = false;

	function ensure() {
		if (ready) return;
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		ready = true;
	}

	return {
		dir,
		// Writes the original and reads it back. Returns the id, or null: then the caller must not shrink.
		save(text) {
			try {
				const size = Buffer.byteLength(text, "utf8");
				const id = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
				const file = path.join(dir, `${id}.txt`);
				ensure();
				if (fs.existsSync(file)) return fs.readFileSync(file, "utf8") === text ? id : null;
				if (bytes + size > MAX_SESSION_BYTES) return null;
				fs.writeFileSync(file, text, { mode: 0o600 });
				if (fs.readFileSync(file, "utf8") !== text) return null;
				bytes += size;
				return id;
			} catch {
				return null;
			}
		},
		get(id) {
			if (!ID.test(String(id))) return null;
			try {
				return fs.readFileSync(path.join(dir, `${id}.txt`), "utf8");
			} catch {
				return null;
			}
		},
		clear() {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {}
			ready = false;
			bytes = 0;
		},
	};
}

// Reads a part of an original: a line range ("120-180"), the lines that match a regex with
// context, or the whole text. The result is capped, with a note that tells how to narrow it.
export function retrieve(store, { id, lines, grep, context = 2 } = {}) {
	const text = store.get(id);
	if (text == null) return { error: `No original with id ${id} in this session.` };
	const all = text.split("\n");
	let out;
	let label;
	if (typeof grep === "string" && grep) {
		let re;
		try {
			re = new RegExp(grep, "i");
		} catch (e) {
			return { error: `Bad regex: ${e.message}` };
		}
		const ctx = Math.max(0, Math.min(20, Math.floor(Number(context) || 0)));
		const keep = new Set();
		all.forEach((l, i) => {
			if (re.test(l)) for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++) keep.add(j);
		});
		const idx = [...keep].sort((a, b) => a - b);
		const parts = [];
		idx.forEach((i, n) => {
			if (n > 0 && i !== idx[n - 1] + 1) parts.push("--");
			parts.push(`${i + 1}: ${all[i]}`);
		});
		out = parts.join("\n");
		label = `${idx.length} lines match or surround /${grep}/`;
	} else if (typeof lines === "string" && /^\s*\d+\s*-\s*\d+\s*$/.test(lines)) {
		const [a, b] = lines.split("-").map((x) => Number(x.trim()));
		const from = Math.max(1, Math.min(a, b));
		const to = Math.min(all.length, Math.max(a, b));
		out = all.slice(from - 1, to).map((l, k) => `${from + k}: ${l}`).join("\n");
		label = `lines ${from}-${to} of ${all.length}`;
	} else {
		out = text;
		label = `all ${all.length} lines`;
	}
	if (out.length > MAX_RETRIEVE_CHARS) {
		out = `${out.slice(0, MAX_RETRIEVE_CHARS)}\n[mumble: retrieve output stops at ${MAX_RETRIEVE_CHARS} characters. Use lines or grep to get a smaller part.]`;
	}
	return { text: `[original ${id}, ${label}]\n${out}` };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

// Config and originals go to a temporary folder, set before the modules read the paths.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mumble-test-"));
process.env.XDG_CONFIG_HOME = TMP;
process.env.APPDATA = TMP;
process.env.TMPDIR = TMP;

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const load = (f) => import(url.pathToFileURL(path.join(ROOT, "extension", f)).href);
const ext = await load("mumble.js");
const sh = await load("shrink.js");
const st = await load("store.js");
const vo = await load("voice.js");

// ------------------------------------------------------------------ fixtures

function logFixture(n = 600) {
	const lines = Array.from({ length: n }, (_, i) => `2026-11-07 10:00:${String(i % 60).padStart(2, "0")} INFO worker=${i % 4} id=${1000 + i} status=200 ms=${10 + (i % 7)}`);
	lines[300] = "2026-11-07 10:05:00 ERROR worker=2 db timeout after 5000ms";
	lines[301] = "    at Pool.connect (pool.js:42:7)";
	return lines.join("\n");
}

function csvFixture() {
	const rows = ["id,name,score,status", ...Array.from({ length: 400 }, (_, i) => `${i},user${i},${50 + (i % 10)},ok`)];
	rows[200] = "199,user199,999,REJECTED";
	return rows.join("\n");
}

function jsonFixture() {
	const arr = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item${i}`, price: 10 + (i % 5), status: "ok" }));
	arr[150].status = "failed";
	arr[200].price = 99999;
	return JSON.stringify(arr, null, 2);
}

function fakePi() {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	ext.default({
		on: (name, fn) => handlers.set(name, fn),
		registerCommand: (name, spec) => commands.set(name, spec),
		registerTool: (spec) => tools.set(spec.name, spec),
	});
	return { emit: (name, event) => handlers.get(name)(event, {}), commands, tools };
}

const resetConfig = () => fs.rmSync(ext.CONFIG_FILE, { force: true });

// ------------------------------------------------------------------ shrink

test("paths point to the temporary folder", () => {
	assert.ok(ext.CONFIG_FILE.startsWith(TMP), ext.CONFIG_FILE);
	assert.ok(st.ROOT.startsWith(fs.realpathSync(TMP)) || st.ROOT.startsWith(TMP), st.ROOT);
});

test("detect: json, terminal, tabular, log, text", () => {
	assert.equal(sh.detect(jsonFixture()), "json");
	assert.equal(sh.detect("\x1b[32mok\x1b[0m\nline\n"), "terminal");
	assert.equal(sh.detect(csvFixture()), "tabular");
	assert.equal(sh.detect(logFixture()), "log");
	assert.equal(sh.detect("just some prose\nwith two lines"), "text");
});

test("log: keeps errors, stack lines, head and tail; summarizes the elided runs", () => {
	const text = logFixture();
	const out = sh.compressLog(text);
	assert.ok(out.length < text.length / 20, `${out.length}`);
	assert.match(out, /ERROR worker=2 db timeout after 5000ms/);
	assert.match(out, /at Pool\.connect \(pool\.js:42:7\)/);
	assert.match(out, /^2026-11-07 10:00:00 INFO worker=0 id=1000/);
	assert.match(out, /id=1599 status=200 ms=14$/);
	assert.match(out, /lines elided \(mumble\): all status=200; range .*id=1002\.\.1299/);
});

test("terminal: strips ANSI, keeps the final state of a progress line, keeps failures", () => {
	const text = `${Array.from({ length: 300 }, (_, i) => `\x1b[32m✓\x1b[0m test ${i} passes`).join("\n")}\n\x1b[31m✗ test 300 FAILED: expected 1 got 2\x1b[0m\nProgress 10%\rProgress 50%\rProgress 100%\ndone`;
	const out = sh.compressTerminal(text);
	assert.doesNotMatch(out, /\x1b/);
	assert.match(out, /✗ test 300 FAILED: expected 1 got 2/);
	assert.match(out, /\nProgress 100%\n/);
	assert.doesNotMatch(out, /Progress 10%/);
	assert.match(out, /lines elided \(mumble\)/);
});

test("terminal: a progress line whose parts carry other content stays whole", () => {
	const line = "downloading alpha\rcompiling beta gamma\rdone";
	assert.equal(sh.compressTerminal(`${line}\n`), null);
});

test("tabular: keeps header, outliers, rejected rows; output is valid CSV", () => {
	const text = csvFixture();
	const out = sh.compressTabular(text);
	assert.ok(out.length < text.length / 10);
	assert.ok(out.startsWith("id,name,score,status\n"));
	assert.match(out, /199,user199,999,REJECTED/);
	assert.match(out, /rows elided \(mumble\): all status=ok/);
	const rows = sh.parseTable(out).rows;
	assert.ok(rows.every((r) => r.length === 4));
});

test("tabular: markdown table", () => {
	const rows = ["| id | state |", "| --- | --- |", ...Array.from({ length: 40 }, (_, i) => `| ${i} | ok |`)];
	const out = sh.compressTabular(rows.join("\n"));
	assert.ok(out.startsWith("| id | state |\n| --- | --- |\n| 0 | ok |"));
	assert.match(out, /rows elided \(mumble\)/);
});

test("json: keeps structure, error and anomaly elements; adds invariants; stays valid JSON", () => {
	const text = jsonFixture();
	const out = sh.compressJson(text);
	assert.ok(out.length < text.length / 10, `${out.length}`);
	const v = JSON.parse(out);
	assert.ok(v.some((e) => e.status === "failed"));
	assert.ok(v.some((e) => e.price === 99999));
	assert.ok(v.some((e) => e[sh.ELIDED_KEY] > 0 && /all status=ok/.test(e[sh.INVARIANTS_KEY])));
	assert.deepEqual(v.at(-1), { id: 299, name: "item299", price: 14, status: "ok" });
});

test("json: error subtrees stay whole", () => {
	const doc = { errors: Array.from({ length: 50 }, (_, i) => ({ code: i, msg: "x" })), items: Array.from({ length: 50 }, (_, i) => ({ id: i })) };
	const v = JSON.parse(sh.compressJson(JSON.stringify(doc, null, 2)));
	assert.equal(v.errors.length, 50);
	assert.ok(v.items.length < 50);
});

test("json: refuses numbers that JavaScript would change", () => {
	assert.equal(sh.jsonNumbersExact('{"a":12345678901234567890}'), false);
	assert.equal(sh.jsonNumbersExact('{"a":1.0}'), false);
	assert.equal(sh.jsonNumbersExact('{"a":1.5,"b":"12345678901234567890","c":-3}'), true);
	const arr = JSON.parse(jsonFixture());
	arr[5].id = "BIG";
	assert.equal(sh.compressJson(JSON.stringify(arr).replace('"BIG"', "12345678901234567890")), null);
});

test("json: whitespace-only gain is used when large; small gain is not", () => {
	const pretty = JSON.stringify({ a: { b: { c: [1, 2, 3], d: "x" } } }, null, 8);
	assert.ok(sh.compressJson(pretty).length < pretty.length);
	assert.equal(sh.compressJson('{"a": 1}'), null);
});

test("shrink: below minChars nothing happens; plain long text gets the head-and-tail cut", () => {
	assert.equal(sh.shrink("short", { minChars: 3000 }), null);
	const prose = Array.from({ length: 3000 }, (_, i) => `sentence ${i} of a long plain text`).join("\n");
	const r = sh.shrink(prose, { minChars: 3000, maxChars: 5000 });
	assert.equal(r.kind, "cut");
	assert.ok(r.text.length < 5200);
	assert.match(r.text, /lines elided \(mumble\)/);
	assert.ok(r.text.startsWith("sentence 0 "));
	assert.ok(r.text.endsWith("sentence 2999 of a long plain text"));
});

test("shrink: an error keeps more of its end", () => {
	const text = Array.from({ length: 3000 }, (_, i) => `step ${i} done here`).join("\n");
	const ok = sh.cutText(text, 5000, false);
	const err = sh.cutText(text, 5000, true);
	const tail = (s) => s.slice(s.indexOf("elided"));
	assert.ok(tail(err).length > tail(ok).length);
});

test("keepNonRedundant keeps lines with new words, not repeats with new numbers", () => {
	const units = ["start server", "request 1 ok", "request 2 ok", "request 3 ok", "disk almost full"];
	const keep = [true, true, false, false, false];
	sh.keepNonRedundant(units, keep);
	assert.deepEqual(keep, [true, true, false, false, true]);
});

test("summarizeElided: drops secret-looking field names", () => {
	const units = [
		[{ name: "token", value: "abc" }, { name: "lvl", value: "info" }],
		[{ name: "token", value: "abc" }, { name: "lvl", value: "info" }],
	];
	const s = sh.summarizeElided(units, 400);
	assert.match(s, /lvl=info/);
	assert.doesNotMatch(s, /token/);
});

// ------------------------------------------------------------------ store

test("store: save, read back, retrieve by lines and grep, refuse bad ids", () => {
	const store = st.createStore(path.join(TMP, "store-a"));
	const text = logFixture();
	const id = store.save(text);
	assert.match(id, /^[0-9a-f]{12}$/);
	assert.equal(store.save(text), id);
	assert.equal(store.get(id), text);
	assert.equal(store.get("../../etc/passwd"), null);
	const byLines = st.retrieve(store, { id, lines: "301-302" });
	assert.match(byLines.text, /^\[original [0-9a-f]{12}, lines 301-302 of 600\]\n301: .*ERROR.*\n302: {5}at Pool/);
	const byGrep = st.retrieve(store, { id, grep: "timeout", context: 1 });
	assert.match(byGrep.text, /300: .*\n301: .*timeout.*\n302: /);
	assert.match(st.retrieve(store, { id: "000000000000" }).error, /No original/);
	assert.match(st.retrieve(store, { id, grep: "(" }).error, /Bad regex/);
	store.clear();
	assert.equal(store.get(id), null);
});

test("store: fails closed when it cannot write", () => {
	const file = path.join(TMP, "not-a-dir");
	fs.writeFileSync(file, "x");
	assert.equal(st.createStore(file).save("hello"), null);
});

test("store: whole retrieve stops at the cap", () => {
	const store = st.createStore(path.join(TMP, "store-b"));
	const id = store.save("y".repeat(st.MAX_RETRIEVE_CHARS * 2));
	assert.match(st.retrieve(store, { id }).text, /retrieve output stops at/);
	store.clear();
});

test("store: sweep removes folders older than one day", () => {
	const root = path.join(TMP, "sweep");
	fs.mkdirSync(path.join(root, "old"), { recursive: true });
	fs.mkdirSync(path.join(root, "new"), { recursive: true });
	const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
	fs.utimesSync(path.join(root, "old"), old, old);
	st.sweep(root);
	assert.deepEqual(fs.readdirSync(root), ["new"]);
});

// ------------------------------------------------------------------ voice

test("parseModeChange: commands and phrases, with negation and question guards", () => {
	const p = (s) => vo.parseModeChange(s, "ste");
	assert.deepEqual(p("/mumble"), { action: "status" });
	assert.deepEqual(p("/mumble ultra"), { action: "set", voice: "ultra" });
	assert.deepEqual(p("/mumble ste"), { action: "set", voice: "ste" });
	assert.deepEqual(p("/mumble mumble"), { action: "set", voice: "mumble" });
	assert.deepEqual(p("/mumble off"), { action: "set", voice: "off" });
	assert.equal(p("/mumble shout"), null);
	assert.deepEqual(p("stop mumble please"), { action: "set", voice: "off" });
	assert.deepEqual(p("stop mumbling"), { action: "set", voice: "off" });
	assert.deepEqual(p("normal mode"), { action: "set", voice: "off" });
	assert.deepEqual(p("use mumble"), { action: "set", voice: "mumble" });
	assert.deepEqual(p("mumble mode on"), { action: "set", voice: "mumble" });
	assert.deepEqual(p("be brief"), { action: "set", voice: "ste" });
	assert.equal(p("how do I exit vim normal mode"), null);
	assert.equal(p("don't use mumble"), null);
	assert.equal(p("what is mumble mode?"), null);
	assert.equal(p("be brief in the summary"), null);
	assert.equal(p('the docs say "stop mumble" works'), null);
	assert.equal(p("start the mumble-server container"), null);
	assert.equal(p("fix the bug"), null);
});

test("STE voice text obeys its own rules: no semicolons, short sentences", () => {
	const text = vo.voiceText("ste").split("\n").slice(2).join("\n");
	assert.doesNotMatch(text, /;/);
	assert.doesNotMatch(text, /\b(don't|can't|isn't|won't|it's)\b/i);
	for (const line of text.split("\n")) {
		for (const s of line.replace(/^\d+\.\s*/, "").split(/(?<=[.!?])\s+/)) {
			const words = s.split(/\s+/).filter(Boolean).length;
			assert.ok(words <= 20, `${words} words: ${s}`);
		}
	}
});

test("section: voice text plus the shrink note; off keeps only the note", () => {
	for (const v of ["ste", "mumble", "ultra"]) {
		const s = vo.section(v);
		assert.ok(s.startsWith(vo.MARKER));
		assert.equal(s.split(vo.MARKER).length, 2, "one marker");
		assert.match(s, /mumble_retrieve/);
	}
	assert.equal(vo.section("off"), vo.SHRINK_NOTE);
	assert.ok(vo.section("ste").length < 2600, `${vo.section("ste").length}`);
});

// ------------------------------------------------------------------ extension

test("before_agent_start: never changes the system prompt; prompt phrases switch the voice", async () => {
	resetConfig();
	const pi = fakePi();
	const req = () => pi.emit("before_provider_request", { payload: { system: [{ type: "text", text: "BASE" }], messages: [] } });
	assert.equal(await pi.emit("before_agent_start", { prompt: "fix it", systemPrompt: "BASE" }), undefined);
	assert.equal((await req()).system[0].text, `${vo.section("ste")}\n\nBASE`);
	assert.equal(await pi.emit("before_agent_start", { prompt: "stop mumble", systemPrompt: "BASE" }), undefined);
	assert.equal((await req()).system[0].text, `${vo.SHRINK_NOTE}\n\nBASE`);
	await pi.emit("before_agent_start", { prompt: "/mumble ultra", systemPrompt: "BASE" });
	assert.match((await req()).system[0].text, /^<!-- mumble -->\n## Mumble voice: ultra/);
	ext.writeConfig({ mode: "off" });
	assert.equal(await pi.emit("before_agent_start", { prompt: "x", systemPrompt: "BASE" }), undefined);
	assert.equal(await req(), undefined);
	resetConfig();
});

test("before_provider_request: puts the section at the start of the PI-Desktop prompt, once", async () => {
	resetConfig();
	const pi = fakePi();
	const s = vo.section("ste");
	// Anthropic with OAuth: block 0 is the fixed Claude Code line and stays as it is.
	const payload = { system: [{ type: "text", text: "CLAUDE" }, { type: "text", text: "BASE", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] };
	const r = await pi.emit("before_provider_request", { payload });
	assert.equal(r, payload, "same object, changed in place");
	assert.equal(r.system[0].text, "CLAUDE");
	assert.equal(r.system[1].text, `${s}\n\nBASE`);
	assert.deepEqual(r.system[1].cache_control, { type: "ephemeral" });
	await pi.emit("before_provider_request", { payload });
	assert.equal(payload.system[1].text, `${s}\n\nBASE`, "a retry does not add it twice");
	// Mid-conversation system messages stay as they are.
	const mid = { system: "BASE", messages: [{ role: "system", content: [{ type: "text", text: "UPDATE" }] }] };
	await pi.emit("before_provider_request", { payload: mid });
	assert.equal(mid.system, `${s}\n\nBASE`);
	assert.equal(mid.messages[0].content[0].text, "UPDATE");
	assert.equal(await pi.emit("before_provider_request", { payload: { messages: [{ role: "user", content: "hi" }] } }), undefined);
	assert.equal(await pi.emit("before_provider_request", {}), undefined);
});

test("addToSystemPrompt: each provider payload shape", async () => {
	const { addToSystemPrompt: add } = await load("system-prompt.js");
	const cases = [
		[{ instructions: "BASE", input: [] }, (p) => p.instructions],
		[{ systemInstruction: "BASE", contents: [] }, (p) => p.systemInstruction],
		[{ systemInstruction: { parts: [{ text: "BASE" }] } }, (p) => p.systemInstruction.parts[0].text],
		[{ messages: [{ role: "system", content: "BASE" }, { role: "user", content: "hi" }] }, (p) => p.messages[0].content],
		[{ messages: [{ role: "developer", content: [{ type: "text", text: "BASE" }] }] }, (p) => p.messages[0].content[0].text],
		[{ input: [{ role: "developer", content: "BASE" }, { role: "user", content: "hi" }] }, (p) => p.input[0].content],
		[{ input: [{ role: "system", content: [{ type: "input_text", text: "BASE" }] }] }, (p) => p.input[0].content[0].text],
	];
	for (const [payload, get] of cases) {
		assert.equal(add(payload, "<S>", "start"), true, JSON.stringify(payload));
		assert.equal(get(payload), "<S>\n\nBASE");
		assert.equal(add(payload, "<T>", "end"), true);
		assert.equal(get(payload), "<S>\n\nBASE\n\n<T>");
	}
	assert.equal(add({ messages: [{ role: "user", content: "BASE" }] }, "<S>"), false, "never edits a user message");
	assert.equal(add({ system: [{ type: "image" }] }, "<S>"), false);
	assert.equal(add(null, "<S>"), false);
	assert.equal(add({ system: "BASE" }, ""), false);
});

test("tool_result: shrinks, keeps images, adds the id; retrieve gives the exact lines back", async () => {
	resetConfig();
	const pi = fakePi();
	await pi.emit("session_start", {});
	const text = logFixture();
	const image = { type: "image", data: "AAAA", mimeType: "image/png" };
	const r = await pi.emit("tool_result", { toolName: "Bash", content: [{ type: "text", text }, image] });
	assert.ok(r.content[0].text.length < text.length / 10);
	assert.deepEqual(r.content[1], image);
	const id = r.content[0].text.match(/mumble_retrieve id ([0-9a-f]{12})\]$/)[1];
	const got = await pi.tools.get("mumble_retrieve").execute("call", { id, lines: "1-600" });
	const lines = got.content[0].text.split("\n").slice(1).map((l) => l.replace(/^\d+: /, ""));
	assert.equal(lines.join("\n"), text);
	await pi.emit("session_shutdown", {});
	const gone = await pi.tools.get("mumble_retrieve").execute("call", { id });
	assert.equal(gone.isError, true);
});

test("tool_result: exempt tools, short output and mode off stay unchanged", async () => {
	resetConfig();
	const pi = fakePi();
	const content = [{ type: "text", text: logFixture() }];
	assert.equal(await pi.emit("tool_result", { toolName: "Read", content }), undefined);
	assert.equal(await pi.emit("tool_result", { toolName: "mumble_retrieve", content }), undefined);
	assert.equal(await pi.emit("tool_result", { toolName: "Bash", content: [{ type: "text", text: "ok" }] }), undefined);
	ext.writeConfig({ mode: "off" });
	assert.equal(await pi.emit("tool_result", { toolName: "Bash", content }), undefined);
	resetConfig();
});

test("turn_end and /mumble: counts usage and shrinks; voice, mode and limit commands", async () => {
	resetConfig();
	const pi = fakePi();
	await pi.emit("session_start", {});
	await pi.emit("turn_end", { message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, cost: { total: 0.0123 } } } });
	await pi.emit("tool_result", { toolName: "Bash", content: [{ type: "text", text: csvFixture() }] });
	const notes = [];
	const run = (a) => pi.commands.get("mumble").handler(a, { ui: { notify: (t) => notes.push(t) } });
	await run("");
	assert.match(notes[0], /voice ste/);
	assert.match(notes[0], /cache read 900 \(90%\)/);
	assert.match(notes[0], /cost \$0\.0123/);
	assert.match(notes[0], /Shrunk: 1 tool results \(tabular 1\)/);
	await run("voice mumble");
	assert.equal(ext.readConfig().voice, "mumble");
	await run("ultra");
	assert.equal(ext.readConfig().voice, "ultra");
	await run("voice shout");
	assert.equal(ext.readConfig().voice, "ultra");
	await run("mode off");
	assert.equal(ext.readConfig().mode, "off");
	await run("limit 8000");
	assert.equal(ext.readConfig().maxChars, 8000);
	await run("limit 10");
	assert.equal(ext.readConfig().maxChars, 8000);
	resetConfig();
});

test("normalize: clamps and falls back", () => {
	const n = ext.normalize({ voice: "bad", minChars: 1, maxChars: 1e9, exempt: ["Bash", 3] });
	assert.equal(n.voice, "ste");
	assert.equal(n.minChars, 2000);
	assert.equal(n.maxChars, 200000);
	assert.deepEqual(n.exempt, ["bash"]);
});

test("manifest: files exist, one permission, starts with each session, notes the store", () => {
	const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
	assert.equal(m.id, "eskwisit.mumble");
	assert.equal(m.repository, "https://github.com/eskwisit/pi-mumble");
	for (const f of [m.main, ...m.contributes.agentExtensions]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
	assert.deepEqual(m.permissions, ["agent.extension"]);
	assert.deepEqual(m.activationEvents, ["onStartup"]);
	for (const s of ["agent.extension", "/mumble", "mumble_retrieve", "temporary folder", "config.json", "JuliusBrussee/caveman"]) assert.ok(m.safetyNotes.includes(s), s);
	assert.ok(fs.existsSync(path.join(ROOT, "NOTICE")));
	for (const lang of ["en", "zh-CN"]) for (const key of ["name", "description", "safetyNotes"]) assert.ok(m.i18n[lang][key], `${lang}.${key}`);
	for (const key of ["name", "description", "safetyNotes"]) assert.equal(m.i18n.en[key], m[key], `en.${key}`);
	for (const s of ["agent.extension", "/mumble", "mumble_retrieve", "pi-mumble/config.json"]) assert.ok(m.i18n["zh-CN"].safetyNotes.includes(s), `zh-CN: ${s}`);
});

test("the name caveman appears only in credits", () => {
	const shipped = ["main.js", "manifest.json", "README.md", "CHANGELOG.md", ...fs.readdirSync(path.join(ROOT, "extension")).map((f) => `extension/${f}`)];
	for (const f of shipped) {
		fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
			const rest = line
				.replace(/Credit: .*?JuliusBrussee\/caveman.*?[Ss]ee NOTICE\./g, "")
				.replace(/致谢：.*?JuliusBrussee\/caveman.*?见 NOTICE。/g, "")
				.replace(/\[github\.com\/JuliusBrussee\/caveman\]\(https:\/\/github\.com\/JuliusBrussee\/caveman\)/g, "");
			assert.doesNotMatch(rest, /caveman|ultracave/i, `${f}:${i + 1}: ${line.slice(0, 120)}`);
		});
	}
});

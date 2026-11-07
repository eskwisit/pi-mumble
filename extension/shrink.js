// Mumble: shrink large tool output before the model reads it.
//
// Credit: ported from engine/compressors and engine/detect.go of https://github.com/JuliusBrussee/caveman (Apache-2.0, Copyright 2026 Julius Brussee). See NOTICE.
// Changes from the original: rewritten in JavaScript; only the terminal, log, tabular and JSON
// compressors; no BM25 query bias and no change-point seams; a smaller invariant summary;
// a guard that refuses JSON whose numbers JavaScript cannot keep exactly; a head-and-tail
// fallback for other very long text.
//
// Every compressor is deterministic and fails closed: it returns null when it cannot parse the
// input or when the result is not smaller. The caller then sends the original unchanged.

export const MARK = "(mumble)";

// ---------------------------------------------------------------- shared helpers

const REDUNDANT_CONTAINMENT = 0.9;
const REDUNDANCY_MAX_CLASSES = 64;
const REDUNDANCY_MAX_PROMOTIONS = 128;
const REDUNDANCY_MAX_UNIT_TOKENS = 128;

function tokenize(unit, maskDigits) {
	const vocab = new Set();
	let words = 0;
	for (const raw of String(unit).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
		const token = maskDigits ? raw.replace(/\p{N}+/gu, "#") : raw;
		if (vocab.has(token)) continue;
		vocab.add(token);
		if (/[\p{L}_]/u.test(token)) words += 1;
		if (vocab.size >= REDUNDANCY_MAX_UNIT_TOKENS) break;
	}
	return { vocab, words };
}

function unitVocabulary(unit) {
	const masked = tokenize(unit, true);
	if (masked.words >= 1) return { vocab: masked.vocab, masked: true };
	return { vocab: tokenize(unit, false).vocab, masked: false };
}

function representedBy(dropped, classes) {
	if (dropped.vocab.size === 0) return true;
	const need = Math.ceil(REDUNDANT_CONTAINMENT * dropped.vocab.size);
	for (const cls of classes) {
		if (cls.masked !== dropped.masked) continue;
		let hit = 0;
		for (const token of dropped.vocab) {
			if (cls.vocab.has(token) && ++hit >= need) return true;
		}
	}
	return false;
}

// Promotes to "keep" each dropped unit whose words are not already in a kept unit.
// A line with new content stays; a line that repeats a known shape goes.
export function keepNonRedundant(units, keep) {
	if (units.length !== keep.length) return;
	const kept = [];
	keep.forEach((k, i) => k && kept.push(i));
	const classes = [];
	const step = kept.length > REDUNDANCY_MAX_CLASSES ? Math.floor(kept.length / REDUNDANCY_MAX_CLASSES) : 1;
	for (let n = 0; n < kept.length && classes.length < REDUNDANCY_MAX_CLASSES; n += step) classes.push(unitVocabulary(units[kept[n]]));
	let promotions = 0;
	for (let i = 0; i < units.length; i++) {
		if (keep[i]) continue;
		if (promotions >= REDUNDANCY_MAX_PROMOTIONS) {
			keep[i] = true;
			continue;
		}
		const vocab = unitVocabulary(units[i]);
		if (representedBy(vocab, classes)) continue;
		keep[i] = true;
		promotions += 1;
		classes.push(vocab);
	}
}

// --- invariant summary of an elided run: constant fields, numeric ranges, small enums.

const INV = { maxBytes: 160, minBudget: 96, minUnits: 2, maxValue: 40, maxName: 32, maxFields: 24, maxTracked: 48, maxEnum: 5, maxEnumValue: 24 };
const SECRET_FIELD = /(secret|passw|token|api[_-]?key|authoriz|credential|cookie|session)/i;
const LOGFMT_PAIR = /(?:^|[\s,[{(])([A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s,\]})]+)/g;

function valueUsable(v) {
	return v !== "" && v.length <= INV.maxValue && !v.includes("mumble") && !v.includes("…") && !/\p{Cc}/u.test(v);
}

function isNumber(v) {
	return /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) && Number.isFinite(Number(v));
}

export function objectFields(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	const out = [];
	for (const name of Object.keys(obj).sort()) {
		if (out.length >= INV.maxFields) break;
		const v = obj[name];
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			const value = String(v);
			if (value !== "") out.push({ name, value });
		}
	}
	return out.length ? out : null;
}

export function lineFields(line) {
	const t = line.trim();
	if (t.length > 1 && t[0] === "{" && t.at(-1) === "}") {
		try {
			const fields = objectFields(JSON.parse(t));
			if (fields) return fields;
		} catch {}
	}
	if (!line.includes("=")) return null;
	const out = [];
	for (const m of line.matchAll(LOGFMT_PAIR)) {
		if (out.length >= INV.maxFields) break;
		let value = m[2];
		if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1);
		if (value) out.push({ name: m[1], value });
	}
	return out.length ? out : null;
}

export function summarizeElided(units, elidedBytes) {
	if (units.length < INV.minUnits || units.some((u) => !u || !u.length)) return "";
	const aggs = new Map();
	for (const fields of units) {
		const seenHere = new Set();
		for (const f of fields) {
			if (seenHere.has(f.name)) continue;
			seenHere.add(f.name);
			let a = aggs.get(f.name);
			if (!a) {
				if (aggs.size >= INV.maxTracked) continue;
				a = { seen: 0, constant: true, numeric: isNumber(f.value), first: f.value, min: f.value, max: f.value, counts: new Map(), tooWide: false };
				aggs.set(f.name, a);
			}
			a.seen += 1;
			if (f.value !== a.first) a.constant = false;
			if (a.numeric) {
				if (!isNumber(f.value)) a.numeric = false;
				else {
					if (Number(f.value) < Number(a.min)) a.min = f.value;
					if (Number(f.value) > Number(a.max)) a.max = f.value;
				}
			}
			if (!a.tooWide) {
				if (!a.counts.has(f.value) && a.counts.size >= INV.maxEnum) a.tooWide = true;
				else a.counts.set(f.value, (a.counts.get(f.value) ?? 0) + 1);
			}
		}
	}
	const entries = [];
	for (const [name, a] of aggs) {
		if (!name || name.length > INV.maxName || SECRET_FIELD.test(name)) continue;
		if (a.seen === units.length && a.constant) {
			if (valueUsable(a.first)) entries.push({ kind: "constant", text: `${name}=${a.first}` });
		} else if (a.seen === units.length && a.numeric && a.min !== a.max) {
			if (valueUsable(a.min) && valueUsable(a.max)) entries.push({ kind: "range", text: `${name}=${a.min}..${a.max}` });
		} else if (!a.tooWide && a.counts.size) {
			const buckets = [...a.counts].filter(([v]) => valueUsable(v) && v.length <= INV.maxEnumValue && !/\s/.test(v));
			if (buckets.length !== a.counts.size) continue;
			const absent = units.length - a.seen;
			if (buckets.length + Math.min(absent, 1) > INV.maxEnum) continue;
			buckets.sort((x, y) => y[1] - x[1]);
			if (absent > 0) buckets.push(["absent", absent]);
			if (buckets.every(([, c]) => c === 1)) continue;
			const weak = 2 * buckets.length >= units.length;
			entries.push({ kind: weak ? "enumWeak" : "enum", text: `${name}: ${buckets.map(([v, c]) => `${v}×${c}`).join(" ")}` });
		}
	}
	if (!entries.length) return "";
	let budget = Math.max(INV.minBudget, Math.floor(elidedBytes / 4));
	budget = Math.min(budget, Math.floor(elidedBytes / 2), INV.maxBytes);
	const selected = entries.map(() => true);
	let omitted = 0;
	for (;;) {
		const text = renderInvariants(entries, selected, omitted);
		if (text.length <= budget) return text;
		let victim = -1;
		for (const kind of ["enumWeak", "range", "constant", "enum"]) {
			for (let i = entries.length - 1; i >= 0 && victim < 0; i--) if (selected[i] && entries[i].kind === kind) victim = i;
			if (victim >= 0) break;
		}
		if (victim < 0) return "";
		selected[victim] = false;
		omitted += 1;
	}
}

function renderInvariants(entries, selected, omitted) {
	const pick = (kinds) => entries.filter((e, i) => selected[i] && kinds.includes(e.kind)).map((e) => e.text);
	const sections = [];
	const constants = pick(["constant"]);
	if (constants.length) sections.push(`all ${constants.join(" ")}`);
	sections.push(...pick(["enum", "enumWeak"]));
	const ranges = pick(["range"]);
	if (ranges.length) sections.push(`range ${ranges.join(" ")}`);
	if (!sections.length) return "";
	if (omitted) sections.push(`+${omitted} omitted`);
	return sections.join("; ");
}

function worthEliding(unitCount, markerBytes, elidedBytes, summary) {
	return unitCount >= 3 || (summary !== "" && 2 * markerBytes <= elidedBytes);
}

function marker(n, unit, summary = "") {
	return summary ? `… ${n} ${unit} elided ${MARK}: ${summary} …` : `… ${n} ${unit} elided ${MARK} …`;
}

const MARKER_RE = /(lines|rows|elements) elided \(mumble\)/;

function splitLines(text) {
	const trailing = text.endsWith("\n");
	const lines = text.split("\n");
	if (trailing) lines.pop();
	return { lines, trailing };
}

function joinLines(lines, trailing) {
	return lines.join("\n") + (trailing ? "\n" : "");
}

// Collapses the runs of lines that keep[] does not keep into one marker line each.
function elideRuns(lines, keep, unit, summarize) {
	const out = [];
	let run = [];
	const flush = () => {
		if (!run.length) return;
		const runBytes = run.reduce((n, l) => n + l.length + 1, 0);
		const summary = summarize ? summarize(run, runBytes) : "";
		const m = marker(run.length, unit, summary);
		if (summarize && !worthEliding(run.length, m.length, runBytes, summary)) out.push(...run);
		else out.push(m);
		run = [];
	};
	lines.forEach((line, i) => {
		if (keep[i]) {
			flush();
			out.push(line);
		} else run.push(line);
	});
	flush();
	return out;
}

// ---------------------------------------------------------------- terminal

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const TERM_IMPORTANT = /(\b(ERROR|ERR|FATAL|PANIC|EXCEPTION|TRACEBACK|FAIL|FAILED|FAILURE|WARN|WARNING)\b|[A-Za-z]+Error\b|[A-Za-z]+Exception\b|^\s+at\s|^\s+File "|\.go:\d+|:\d+:\d+:|^\s*--->|caused by|\bexit status [1-9])/i;

function collapseCarriageReturns(line) {
	if (!line.includes("\r")) return line;
	const segs = line.split("\r");
	const visible = segs.map((s) => s.replace(ANSI, ""));
	let last = -1;
	visible.forEach((v, i) => v.length && (last = i));
	if (last < 0) return line;
	const keep = segs.map((_, i) => i === last);
	keepNonRedundant(visible, keep);
	if (keep.some((k, i) => k && i !== last)) return line; // an overwritten part has its own content
	return segs[last];
}

export function compressTerminal(text) {
	if (!text) return null;
	const { lines, trailing } = splitLines(text);
	const clean = lines.map((l) => {
		const cr = l.endsWith("\r");
		const body = collapseCarriageReturns(cr ? l.slice(0, -1) : l).replace(ANSI, "");
		return cr ? `${body}\r` : body;
	});
	let out = clean;
	if (clean.length >= 4) {
		const keep = clean.map((l, i) => i < 3 || i >= clean.length - 3 || TERM_IMPORTANT.test(l) || MARKER_RE.test(l));
		keepNonRedundant(clean, keep);
		out = elideRuns(clean, keep, "lines", null);
	}
	const result = joinLines(out, trailing);
	return result === text ? null : result;
}

// ---------------------------------------------------------------- log

const LOG_IMPORTANT = /(\b(ERROR|FATAL|PANIC|EXCEPTION|TRACEBACK|FAIL|FAILED|FAILURE|WARN|WARNING|CRIT|CRITICAL|ALERT|EMERG|EMERGENCY)\b|^\s+at\s|^\s+File "|\.go:\d+|^\s+--->|caused by)/i;

export function compressLog(text) {
	const { lines, trailing } = splitLines(text);
	if (lines.length < 4) return null;
	const keep = lines.map((l, i) => i < 2 || LOG_IMPORTANT.test(l) || MARKER_RE.test(l));
	for (let i = lines.length - 1, budget = 2; i >= 2 && budget > 0; i--, budget--) keep[i] = true;
	keepNonRedundant(lines, keep);
	const out = elideRuns(lines, keep, "lines", (run, bytes) => summarizeElided(run.map(lineFields), bytes));
	const result = joinLines(out, trailing);
	return result.length < text.length ? result : null;
}

// ---------------------------------------------------------------- tabular (CSV, TSV, Markdown)

const TABLE_IMPORTANT = /\b(ERROR|FAIL|FAILED|FATAL|PANIC|EXCEPTION|WARNING|SECURITY|DENIED|REJECTED)\b/i;

function parseDelimited(text, delim) {
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else quoted = false;
			} else cell += ch;
		} else if (ch === '"' && cell === "") quoted = true;
		else if (ch === delim) {
			row.push(cell);
			cell = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += ch;
	}
	if (quoted) return null;
	if (cell !== "" || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

export function parseTable(text) {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const lines = trimmed.split(/\r?\n/);
	if (lines.length >= 3 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) {
		const cells = (l) => l.trim().slice(1, -1).split("|").map((c) => c.trim());
		const sep = cells(lines[1]);
		if (sep.every((c) => /^:?-{3,}:?$/.test(c))) {
			const rows = lines.map(cells);
			if (rows.every((r) => r.length === rows[0].length)) return { kind: "markdown", rows, headerRows: 2 };
		}
		return null;
	}
	const first = lines[0];
	const tabs = (first.match(/\t/g) ?? []).length;
	const commas = (first.match(/,/g) ?? []).length;
	const delim = tabs >= 1 && tabs > commas ? "\t" : ",";
	if ((delim === "\t" ? tabs : commas) < 1) return null;
	const rows = parseDelimited(trimmed, delim);
	if (!rows || rows.length < 2 || rows.some((r) => r.length !== rows[0].length)) return null;
	return { kind: delim === "\t" ? "tsv" : "csv", rows, headerRows: 1, delim, crlf: text.includes("\r\n") };
}

export function looksTabular(text) {
	const t = parseTable(text);
	return !!t && t.rows.length >= 8;
}

function writeCell(cell, delim) {
	return /["\r\n]/.test(cell) || cell.includes(delim) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function keepNumericExtrema(rows, headerRows, keep) {
	const cols = rows[0].length;
	for (let c = 0; c < cols; c++) {
		let min = -1;
		let max = -1;
		let numeric = true;
		for (let r = headerRows; r < rows.length && numeric; r++) {
			const v = rows[r][c].trim();
			if (!isNumber(v)) numeric = false;
			else {
				if (min < 0 || Number(v) < Number(rows[min][c])) min = r;
				if (max < 0 || Number(v) > Number(rows[max][c])) max = r;
			}
		}
		if (numeric && min >= 0 && rows[min][c].trim() !== rows[max][c].trim()) keep[min] = keep[max] = true;
	}
}

export function compressTabular(text) {
	if (MARKER_RE.test(text)) return null;
	const table = parseTable(text);
	if (!table) return null;
	const { rows, headerRows } = table;
	if (rows.length < 12 || rows.length <= headerRows + 3 + 2 + 1) return null;
	const keep = rows.map((_, i) => i < headerRows + 3 || i >= rows.length - 2);
	const docs = rows.map((r) => r.join(" "));
	docs.forEach((d, i) => TABLE_IMPORTANT.test(d) && (keep[i] = true));
	keepNumericExtrema(rows, headerRows, keep);
	keepNonRedundant(docs, keep);
	const header = rows[0];
	const shaped = [];
	let run = [];
	const flush = () => {
		if (!run.length) return;
		const runBytes = run.reduce((n, r) => n + r.join(",").length + 1, 0);
		const fields = run.map((r) => {
			const f = r.map((v, i) => ({ name: (header[i] ?? "").trim(), value: v.trim() })).filter((x) => x.name && x.value);
			return f.length ? f : null;
		});
		const summary = summarizeElided(fields, runBytes);
		const m = marker(run.length, "rows", summary);
		if (!worthEliding(run.length, m.length, runBytes, summary)) shaped.push(...run);
		else shaped.push([m, ...Array(header.length - 1).fill("")]);
		run = [];
	};
	rows.forEach((r, i) => {
		if (keep[i]) {
			flush();
			shaped.push(r);
		} else run.push(r);
	});
	flush();
	if (shaped.length >= rows.length) return null;
	const nl = table.crlf ? "\r\n" : "\n";
	const out =
		table.kind === "markdown"
			? shaped.map((r) => `| ${r.join(" | ")} |`).join(nl)
			: shaped.map((r) => r.map((c) => writeCell(c, table.delim)).join(table.delim)).join(nl);
	const result = text.endsWith("\n") ? out + nl : out;
	return result.length < text.length ? result : null;
}

// ---------------------------------------------------------------- JSON

const ERROR_KEY = /^(error|errors|message|msg|stack|stacktrace|stack_trace|trace|traceback|exception|reason|detail|details|warning|warnings)$/i;
const ERROR_VALUE = /\b(error|errors|exception|failed|failure|critical|fatal|crash|panic|abort|timeout|denied|rejected)\b/i;
export const ELIDED_KEY = "__elided__";
export const INVARIANTS_KEY = "__invariants__";
const JSON_ARRAY_THRESHOLD = 8;

// JSON.parse turns 12345678901234567890 into 12345678901234567000, and 1.0 into 1.
// Refuse any document whose numbers do not survive a round trip unchanged.
export function jsonNumbersExact(text) {
	for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
		const tok = m[0];
		if (tok[0] === '"') continue;
		if (String(Number(tok)) !== tok) return false;
	}
	return true;
}

function numericLeaves(v, prefix, out) {
	if (typeof v === "number") out.set(prefix, v);
	else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) numericLeaves(x, prefix ? `${prefix}.${k}` : k, out);
}

function medianAndScale(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const med = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
	const m = med(s);
	const mad = med(s.map((x) => Math.abs(x - m)).sort((a, b) => a - b));
	if (mad > 0) return [m, mad];
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	const std = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
	return [m, std * 0.6745];
}

// Robust MAD-based z for each numeric path and for the element length.
function anomalyIndices(arr, docs, z) {
	const byPath = new Map();
	arr.forEach((e, i) => {
		const leaves = new Map();
		numericLeaves(e, "", leaves);
		for (const [p, v] of leaves) {
			if (!byPath.has(p)) byPath.set(p, []);
			byPath.get(p).push([i, v]);
		}
	});
	byPath.set("\0len", docs.map((d, i) => [i, d.length]));
	const out = new Set();
	for (const pairs of byPath.values()) {
		if (pairs.length < 4) continue;
		const [med, scale] = medianAndScale(pairs.map(([, v]) => v));
		if (!(scale > 0)) continue;
		for (const [i, v] of pairs) if ((0.6745 * Math.abs(v - med)) / scale >= z) out.add(i);
	}
	return out;
}

function selectArray(arr, state) {
	const n = arr.length;
	const docs = arr.map((e) => JSON.stringify(e) ?? "");
	const keep = arr.map((_, i) => i < 3 || i >= n - 2);
	docs.forEach((d, i) => ERROR_VALUE.test(d) && (keep[i] = true));
	for (const i of anomalyIndices(arr, docs, 2.0)) keep[i] = true;
	keepNonRedundant(docs, keep);
	const out = [];
	let run = [];
	let runDocs = [];
	const flush = () => {
		if (!run.length) return;
		const bytes = runDocs.reduce((a, d) => a + d.length + 1, 0);
		const summary = summarizeElided(run.map(objectFields), bytes);
		if (!worthEliding(run.length, summary.length + 40, bytes, summary)) out.push(...run.map((e) => transformJson(e, false, state)));
		else {
			out.push(summary ? { [ELIDED_KEY]: run.length, [INVARIANTS_KEY]: summary } : { [ELIDED_KEY]: run.length });
			state.collapsed = true;
		}
		run = [];
		runDocs = [];
	};
	arr.forEach((e, i) => {
		if (keep[i]) {
			flush();
			out.push(transformJson(e, false, state));
		} else {
			run.push(e);
			runDocs.push(docs[i]);
		}
	});
	flush();
	return out;
}

function transformJson(v, preserve, state) {
	if (Array.isArray(v)) {
		if (preserve || v.some((e) => e && typeof e === "object" && ELIDED_KEY in e)) return v;
		if (v.length <= JSON_ARRAY_THRESHOLD) return v.map((e) => transformJson(e, false, state));
		return selectArray(v, state);
	}
	if (v && typeof v === "object") {
		const out = {};
		for (const [k, x] of Object.entries(v)) out[k] = transformJson(x, preserve || ERROR_KEY.test(k), state);
		return out;
	}
	return v;
}

export function compressJson(text) {
	const t = text.trim();
	if (!(t.startsWith("{") || t.startsWith("["))) return null;
	let v;
	try {
		v = JSON.parse(t);
	} catch {
		return null;
	}
	if (!jsonNumbersExact(t)) return null;
	const state = { collapsed: false };
	const shaped = transformJson(v, false, state);
	const compact = JSON.stringify(shaped);
	// Whitespace alone counts too: compact JSON gives the model the same data for fewer tokens.
	if (!state.collapsed && compact.length > t.length * 0.8) return null;
	return compact.length < text.length ? compact : null;
}

// ---------------------------------------------------------------- detection and fallback

const LOG_LINE = /(\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRIT|CRITICAL|ALERT|EMERG|EMERGENCY)\b|^\s*\[[A-Z]+\]|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b)/i;

function looksLikeLog(text) {
	const lines = text.split("\n");
	if (lines.length < 4) return false;
	const matched = lines.filter((l) => LOG_LINE.test(l)).length;
	return matched >= 3 && matched * 2 >= lines.length;
}

function looksLikeTerminal(text) {
	if (/\x1b\[[0-9;?]*[ -/]*[@-~]/.test(text)) return true;
	if (!text.includes("\n")) return false;
	return (text.match(/\r/g) ?? []).length - (text.match(/\r\n/g) ?? []).length >= 3;
}

export function detect(text) {
	const t = text.trim();
	if ((t.startsWith("{") || t.startsWith("[")) && (() => { try { JSON.parse(t); return true; } catch { return false; } })()) return "json";
	if (looksLikeTerminal(text)) return "terminal";
	if (looksTabular(text)) return "tabular";
	if (looksLikeLog(text)) return "log";
	return "text";
}

// Keeps the start and the end of a long text, cut at line ends. An error keeps more of its end.
export function cutText(text, maxChars, isError = false) {
	if (typeof text !== "string" || text.length <= maxChars) return null;
	const tailBudget = Math.floor(maxChars * (isError ? 0.6 : 0.4));
	const headBudget = maxChars - tailBudget;
	let head = text.slice(0, headBudget);
	const headNl = head.lastIndexOf("\n");
	if (headNl > headBudget / 2) head = head.slice(0, headNl + 1);
	let tail = text.slice(text.length - tailBudget);
	const tailNl = tail.indexOf("\n");
	if (tailNl >= 0 && tailNl < tailBudget / 2) tail = tail.slice(tailNl + 1);
	const middle = text.slice(head.length, text.length - tail.length);
	const lines = middle.split("\n").length - (middle.endsWith("\n") ? 1 : 0);
	return `${head}${marker(lines, "lines")}\n${tail}`;
}

const COMPRESSORS = { json: compressJson, terminal: compressTerminal, tabular: compressTabular, log: compressLog };

// Returns { text, kind } or null. Structured compressors run above minChars. The head-and-tail
// cut runs above maxChars, also on the output of a structured compressor that is still too long.
export function shrink(text, { minChars = 3000, maxChars = 20000, isError = false } = {}) {
	if (typeof text !== "string" || text.length < minChars) return null;
	const kind = detect(text);
	let out = null;
	try {
		out = COMPRESSORS[kind]?.(text) ?? null;
	} catch {
		out = null;
	}
	let used = out ? kind : null;
	const base = out ?? text;
	if (base.length > maxChars) {
		const cut = cutText(base, maxChars, isError);
		if (cut) {
			out = cut;
			used = used ? `${used}+cut` : "cut";
		}
	}
	return out && out.length < text.length ? { text: out, kind: used } : null;
}

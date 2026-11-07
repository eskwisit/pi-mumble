// Mumble: loads in each agent session and cuts token cost. Three parts:
// 1. Say less: a voice section in the system prompt (default "ste": ASD-STE100, short answers).
// 2. Read less: large tool output is shrunk by content type (JSON, logs, tables, terminal output),
//    and the exact original stays on disk. The mumble_retrieve tool gets it back.
// 3. Count: tokens, cache reads, cost and shrink savings of the session. /mumble shows them.
// Credit: the design follows https://github.com/JuliusBrussee/caveman (Apache-2.0, Copyright 2026 Julius Brussee). See NOTICE.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shrink } from "./shrink.js";
import { createStore, retrieve, sweep } from "./store.js";
import { addToSystemPrompt } from "./system-prompt.js";
import { VOICES, parseModeChange, section } from "./voice.js";

export const MODES = ["on", "off"];
export const DEFAULTS = Object.freeze({
	mode: "on",
	voice: "ste",
	minChars: 3000,
	maxChars: 20000,
	// Their text is already bounded, or the agent asked for all of it.
	exempt: ["read", "edit", "write", "skill", "task", "taskwait", "todowrite", "asktool", "mumble_retrieve"],
});
export const LIMITS = Object.freeze({ min: 2000, max: 200000 });
const CHARS_PER_TOKEN = 4;

export const CONFIG_FILE =
	process.platform === "win32"
		? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "pi-mumble", "config.json")
		: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pi-mumble", "config.json");

function readConfigFile(file) {
	try {
		const c = JSON.parse(fs.readFileSync(file, "utf8"));
		return c && typeof c === "object" && !Array.isArray(c) ? c : {};
	} catch {
		return {};
	}
}

const clamp = (n, fallback) => (Number.isFinite(Number(n)) ? Math.min(LIMITS.max, Math.max(LIMITS.min, Math.round(Number(n)))) : fallback);

export function normalize(c) {
	return {
		mode: MODES.includes(c.mode) ? c.mode : DEFAULTS.mode,
		voice: VOICES.includes(c.voice) ? c.voice : DEFAULTS.voice,
		minChars: clamp(c.minChars, DEFAULTS.minChars),
		maxChars: clamp(c.maxChars, DEFAULTS.maxChars),
		exempt: Array.isArray(c.exempt) ? c.exempt.filter((x) => typeof x === "string").map((x) => x.toLowerCase()) : DEFAULTS.exempt,
	};
}

export function readConfig(file = CONFIG_FILE) {
	return normalize(readConfigFile(file));
}

export function writeConfig(patch, file = CONFIG_FILE) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ ...readConfigFile(file), ...patch }, null, "\t")}\n`);
}

export function newStats() {
	return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, shrunk: 0, before: 0, after: 0, kinds: {}, retrieves: 0 };
}

export function addUsage(stats, usage) {
	if (!usage || typeof usage !== "object") return;
	const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
	stats.turns += 1;
	stats.input += num(usage.input);
	stats.output += num(usage.output);
	stats.cacheRead += num(usage.cacheRead);
	stats.cacheWrite += num(usage.cacheWrite);
	stats.cost += num(usage.cost?.total);
}

export function report(stats, cfg, voice) {
	const k = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n));
	const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
	const hit = prompt ? Math.round((stats.cacheRead / prompt) * 100) : 0;
	const kinds = Object.entries(stats.kinds).map(([kind, n]) => `${kind} ${n}`).join(", ") || "none";
	const saved = Math.round((stats.before - stats.after) / CHARS_PER_TOKEN);
	return [
		`Mumble · mode ${cfg.mode} · voice ${voice} · shrink above ${cfg.minChars}, cut above ${cfg.maxChars} characters`,
		`Session: ${stats.turns} turns · input ${k(stats.input)} · output ${k(stats.output)} · cache read ${k(stats.cacheRead)} (${hit}%) · cache write ${k(stats.cacheWrite)} · cost $${stats.cost.toFixed(4)}`,
		`Shrunk: ${stats.shrunk} tool results (${kinds}) · about ${k(saved)} tokens less in each later turn · ${stats.retrieves} retrieves`,
	].join("\n");
}

const RETRIEVE_TOOL = {
	name: "mumble_retrieve",
	label: "Mumble retrieve",
	description:
		"Get the exact original of a tool result that Mumble shrank. Give the id from its last line. Use grep (regex, with context lines) or lines (\"120-180\") to get only the part you need.",
	promptSnippet: "Exact original of a shrunk tool result",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "12 hex characters, from the shrunk result" },
			grep: { type: "string", description: "Regex, case-insensitive" },
			context: { type: "number", description: "Lines around each grep match, default 2" },
			lines: { type: "string", description: "1-based range, e.g. 120-180" },
		},
		required: ["id"],
	},
};

export default function mumble(pi) {
	let stats = newStats();
	let voice = readConfig().voice;
	let store = createStore();

	pi.on("session_start", async () => {
		stats = newStats();
		voice = readConfig().voice;
		store.clear();
		store = createStore();
		sweep();
	});

	pi.on("before_agent_start", async (event) => {
		const cfg = readConfig();
		if (cfg.mode === "off") return;
		const change = parseModeChange(event?.prompt, cfg.voice);
		if (change?.action === "set") voice = change.voice;
		// No systemPrompt here: PI-Desktop stores a changed prompt as a new system message, and
		// Anthropic models then get the whole prompt twice. before_provider_request adds the section.
	});

	pi.on("before_provider_request", async (event) => {
		if (readConfig().mode === "off") return;
		const payload = event?.payload;
		// At the start, not the end: the host changes later parts of its prompt during a session,
		// and the prompt cache keeps only the part before the first change.
		if (!addToSystemPrompt(payload, section(voice), "start")) return;
		return payload;
	});

	pi.on("tool_result", async (event) => {
		const cfg = readConfig();
		if (cfg.mode === "off") return;
		const tool = String(event?.toolName ?? "").toLowerCase();
		if (cfg.exempt.includes(tool) || !Array.isArray(event?.content)) return;
		const textParts = event.content.filter((c) => c?.type === "text" && typeof c.text === "string");
		if (!textParts.length) return;
		const text = textParts.map((c) => c.text).join("\n");
		const r = shrink(text, { minChars: cfg.minChars, maxChars: cfg.maxChars, isError: !!event.isError });
		if (!r) return;
		// No original on disk, no shrinking: the agent must always be able to get the full text.
		const id = store.save(text);
		if (!id) return;
		const footer = `\n[mumble: ${r.kind} output shrunk from ${text.length} to ${r.text.length} characters. Exact original: mumble_retrieve id ${id}]`;
		const out = r.text + footer;
		if (out.length >= text.length) return;
		stats.shrunk += 1;
		stats.before += text.length;
		stats.after += out.length;
		stats.kinds[r.kind] = (stats.kinds[r.kind] ?? 0) + 1;
		return { content: [{ type: "text", text: out }, ...event.content.filter((c) => c?.type !== "text")] };
	});

	pi.on("turn_end", async (event) => {
		const m = event?.message;
		if (m?.role === "assistant") addUsage(stats, m.usage);
	});

	pi.on("session_shutdown", async () => {
		store.clear();
	});

	pi.registerTool({
		...RETRIEVE_TOOL,
		async execute(_id, params) {
			const r = retrieve(store, params ?? {});
			if (!r.error) stats.retrieves += 1;
			return { content: [{ type: "text", text: r.error ?? r.text }], details: {}, ...(r.error ? { isError: true } : {}) };
		},
	});

	pi.registerCommand?.("mumble", {
		description: "Mumble: session cost, or `ste|mumble|ultra|off` (the voice), `mode on|off`, `limit <characters>`",
		handler: async (args, ctx) => {
			let [sub, value] = String(args ?? "").trim().toLowerCase().split(/\s+/);
			if (VOICES.includes(sub)) [sub, value] = ["voice", sub];
			const notify = (text) => ctx?.ui?.notify?.(text, "info");
			if (sub === "voice") {
				if (!VOICES.includes(value)) return notify(`Mumble voice is ${voice}. Use: /mumble ${VOICES.join("|")}`);
				voice = value;
				writeConfig({ voice: value });
				return notify(`Mumble voice: ${value}. It applies from the next turn.`);
			}
			if (sub === "mode") {
				if (!MODES.includes(value)) return notify(`Mumble mode is ${readConfig().mode}. Use: /mumble mode on|off`);
				writeConfig({ mode: value });
				return notify(`Mumble mode: ${value}. It applies from the next turn.`);
			}
			if (sub === "limit") {
				const n = Number(value);
				if (!Number.isFinite(n) || n < LIMITS.min || n > LIMITS.max) {
					return notify(`Mumble limit is ${readConfig().maxChars}. Use: /mumble limit <${LIMITS.min}-${LIMITS.max}>`);
				}
				writeConfig({ maxChars: Math.round(n) });
				return notify(`Mumble limit: ${Math.round(n)} characters per tool result`);
			}
			notify(report(stats, readConfig(), voice));
		},
	});
}

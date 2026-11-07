// Mumble voice modes and the mode switch.
//
// Credit: the mumble and ultra texts and the trigger parser are adapted from https://github.com/JuliusBrussee/caveman (Apache-2.0, Copyright 2026 Julius Brussee). See NOTICE.
// Changes: condensed texts, a new "ste" voice that obeys ASD-STE100, a smaller parser.

export const MARKER = "<!-- mumble -->";
export const VOICES = ["ste", "mumble", "ultra", "off"];

// Default. The mumble voice drops articles and ultra uses fragments: that breaks STE rule 4.2
// (do not omit words) and rule 4.5 (use articles). This voice keeps the cuts that STE permits.
const STE = `${MARKER}
## Mumble voice: STE
Write each reply in ASD-STE100 Simplified Technical English. Remove all words that give no information. Keep all facts.
1. Give the answer first. Then give the reason. Then give the next step.
2. Do not write greetings, apologies, filler words, a recap or an offer of more help.
3. Write one instruction in each sentence, in the imperative form. Use a maximum of 20 words.
4. Use a maximum of 25 words in each descriptive sentence. Write one topic in each paragraph.
5. Use the active voice and the simple tenses.
6. Keep the articles and all other necessary words. Do not use contractions or semicolons.
7. Use one term for one thing. Use short, simple words that have one meaning.
8. Keep code, commands, paths, numbers, units and error messages exactly as they are.
9. Keep each "not", "no", "never" and "only".
10. For a code change, show only the changed lines and one or two lines of context.
11. Do not write text between routine tool calls. Write one line before a long task and one line with the result.
Use full sentences for a safety warning, an action that you cannot undo, and a question to the user.
Write documents and memory files in STE too. Code, code comments and commit messages keep their usual style.
Reply in the language of the user. For a language that is not English, apply rules 1, 2 and 8 to 11.`;

const MUMBLE = `${MARKER}
## Mumble voice: mumble
Respond terse. All technical substance stays. Only fluff goes.
- Answer first: answer, then reason, then next step. Pattern: [thing] [action] [reason]. [next step].
- No greeting, hedging, pleasantries, recap or closer. No "Sure!", "Let me", "Hope this helps".
- Short words: "fix", not "implement a solution for". No invented abbreviations. No arrows.
- Articles optional when the sentence still reads in one pass. Never drop not/never/no/only/except.
- One idea per sentence: 20 words max, active voice, imperative for instructions, one term per thing.
- Payload verbatim: code, commands, paths, API names, numbers and errors stay exact. Code change: changed lines plus 1-2 lines of context.
- No text between routine tool calls. One line before a multi-step run, one line with the result.
- No performance: no voice announcement, no prefix, no mangled grammar for flavor. Terse phrasing not shorter? Use plain.
Plain prose for security warnings, irreversible actions, step order a fragment could scramble, a confused user, and questions to the user. Then resume.
Code, comments, commits, docs and memory files: written normal.
Reply in the user's language.`;

const ULTRA = `${MARKER}
## Mumble voice: ultra
The mumble voice at maximum compression. Payload only.
- Fragments: drop articles, copulas and connectives when order stays clear.
- One word when one word is enough. Each fact once. No summary after a list.
- Never cut: code, commands, paths, API names, errors, not/never/no/only/except, numbers, units.
- Tool runs: one line in, one line out.
- Fragment with two readings? Full sentence.
Plain prose for security warnings, irreversible actions, a confused user, and questions to the user.
Code, comments, commits, docs and memory files: written normal.
Reply in the user's language.`;

// Told in every voice, also "off": the shrunk tool results need it.
export const SHRINK_NOTE = `${MARKER}
## Mumble: shrunk tool results
A long tool result can show "elided (mumble)" markers and a last line with an original id. The shown part keeps the errors, the unusual entries and a summary of each elided part. Use the shown part first. If you must have more, call mumble_retrieve with that id and with grep or lines.`;

const TEXTS = { ste: STE, mumble: MUMBLE, ultra: ULTRA, off: "" };

export function voiceText(voice) {
	return TEXTS[voice] ?? "";
}

// The system prompt section for a voice. The text is fixed for each voice, so the prompt
// cache stays valid from turn to turn.
export function section(voice) {
	const text = voiceText(voice);
	return text ? `${text}\n\n${SHRINK_NOTE.slice(MARKER.length + 1)}` : SHRINK_NOTE;
}

// ------------------------------------------------------------------ trigger parser

const QUOTED_SPAN = /(["`])(?:(?!\1).)*\1/g;
const NEGATOR = /\b(?:don['’]?t|do not|doesn['’]?t|does not|won['’]?t|will not|never|no need to|rather not)\b/;
const CLAUSE_BOUNDARY = /[.;!?,:—–]|\s-+\s|\bbut\b|\bthen\b/g;
const ACTIVATION_VERB = /\b(?:activate|enable|start|turn on|use|switch to|want|give me)\b(?:\s+(?:the|to|into|on|in|please|now|it|me|my|this|that|mode))*\s+mumble\b(?![-\w])/g;
const MUMBLE_ON = /\bmumble\s+mode\s+(?:on|please|now)\b/g;
const BARE_MUMBLE = /^mumble(?:\s+mode)?\s*[.!]*$/g;
const BREVITY = /\b(?:less tokens|fewer tokens|be brief|be terse|shorter answers)\b(?!\s+(?:in|for|on|about|when|during|with)\b)/g;
const QUESTION = /^(what|whats|what's|how|why|when|where|who|does|do|did|is|are|can|could|would|should|tell me|explain)\b/;

function negatedBefore(text, index) {
	CLAUSE_BOUNDARY.lastIndex = 0;
	let start = 0;
	let m;
	while ((m = CLAUSE_BOUNDARY.exec(text)) !== null) {
		if (m.index >= index) break;
		start = m.index + m[0].length;
	}
	return NEGATOR.test(text.slice(start, index));
}

function firstUnnegated(re, text) {
	re.lastIndex = 0;
	let m;
	while ((m = re.exec(text)) !== null) {
		if (!negatedBefore(text, m.index)) return true;
		if (m.index === re.lastIndex) re.lastIndex++;
	}
	return false;
}

// The argument of "/mumble <arg>": a voice name, "status", or an off word.
export function commandArg(arg) {
	const a = String(arg ?? "").toLowerCase().replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9-]+$/, "");
	if (a === "" || a === "status") return { action: "status" };
	if (["off", "stop", "disable"].includes(a)) return { action: "set", voice: "off" };
	if (VOICES.includes(a)) return { action: "set", voice: a };
	return null;
}

// Reads a user prompt. Returns { action: "set", voice }, { action: "status" } or null.
// defaultVoice is the voice for a request that names no voice ("be brief").
export function parseModeChange(raw, defaultVoice = "ste") {
	const prompt = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
	if (!prompt) return null;
	if (prompt.startsWith("/")) {
		const [cmd, arg] = prompt.split(" ");
		return cmd === "/mumble" ? commandArg(arg) : null;
	}
	const nl = prompt.replace(QUOTED_SPAN, " ");
	const off =
		/\b(stop|disable|deactivate|quit|exit|kill)\s+(the\s+)?mumbl(e|ing)\b(?!-)/.test(nl) ||
		/\bmumble(\s+mode)?\s+(off|stop|disabled?)\b/.test(nl) ||
		/\bturn\s+off\s+(the\s+)?mumble\b/.test(nl) ||
		/^(please\s+)?(go\s+(back\s+)?(to\s+)?|back\s+to\s+|switch\s+(back\s+)?to\s+|return\s+to\s+)?normal\s+mode\b/.test(nl) ||
		(/\bnormal\s+mode\b/.test(nl) && /\bmumble\b/.test(nl));
	if (off) return { action: "set", voice: "off" };
	if (QUESTION.test(nl)) return null;
	if ([ACTIVATION_VERB, MUMBLE_ON, BARE_MUMBLE].some((re) => firstUnnegated(re, nl))) return { action: "set", voice: "mumble" };
	if (firstUnnegated(BREVITY, nl)) return { action: "set", voice: defaultVoice === "off" ? "ste" : defaultVoice };
	return null;
}

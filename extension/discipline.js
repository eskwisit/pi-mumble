// Keeps the voice for the whole session. The voice section sits at the start of the system prompt,
// far from the newest turn: in a long session with many tool calls, replies drift back to full prose.
// Two parts, both outside the stored conversation:
// 1. Remind: each human message in the provider request carries a one-line reminder of the voice
//    (before_provider_request: the session file and the host's messages do not change). The text of
//    a message's reminder never changes after it is first sent, so the prompt cache stays valid.
//    Not the `context` hook: a returned message list replaces the host's messages with copies, and
//    the host then lost its system message order (Anthropic OAuth requests failed with 429 "Error").
// 2. Check: each final reply (no tool calls) is measured against the budget of the voice. When a reply
//    is over the budget, the reminder on the next human message says so, with the numbers.

export const MARK = "[mumble]";

// Reply budget in tokens (characters / 4), code blocks not counted. ste has no hard cap.
export const BUDGETS = Object.freeze({ ultra: 250, mumble: 400, ste: 700 });
const CHARS_PER_TOKEN = 4;

const REMINDERS = {
	ultra: `${MARK} Voice ultra: fragments, no articles or filler, each fact once, no recap. Reply max ${BUDGETS.ultra} tokens, code apart.`,
	mumble: `${MARK} Voice mumble: terse, no filler, hedging or recap. Reply max ${BUDGETS.mumble} tokens, code apart.`,
	ste: `${MARK} Voice STE: answer first, short active sentences, no filler or recap. Reply max ${BUDGETS.ste} tokens, code apart.`,
};

export function reminderText(voice) {
	return REMINDERS[voice] ?? "";
}

const FENCE = /```[\s\S]*?(?:```|$)/g;
const ARTICLE = /\b(?:the|a|an)\b/gi;

// The prose of a reply: code blocks out. Tokens are characters / 4, as the rest of Mumble counts.
export function measure(text) {
	const prose = String(text ?? "").replace(FENCE, " ");
	const words = prose.split(/\s+/).filter(Boolean).length;
	return {
		tokens: Math.round(prose.trim().length / CHARS_PER_TOKEN),
		words,
		articles: (prose.match(ARTICLE) ?? []).length,
	};
}

// The text of a final assistant reply, or null for a reply that calls tools (it is not the answer yet).
export function finalReplyText(message) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
	if (message.content.some((c) => c?.type === "toolCall" || c?.type === "tool_use")) return null;
	const text = message.content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
	return text || null;
}

// What the check found in one reply: over the budget, and for ultra too many articles (more than 1 in 25 words).
export function verdict(voice, m) {
	const budget = BUDGETS[voice];
	if (!budget || !m) return null;
	const over = m.tokens > budget;
	const wordy = voice === "ultra" && m.words >= 40 && m.articles * 25 > m.words;
	return over || wordy ? { ...m, budget, over, wordy } : null;
}

// The feedback line for the next human message, or "".
export function feedbackText(v) {
	if (!v) return "";
	const parts = [];
	if (v.over) parts.push(`~${v.tokens} tokens, budget ${v.budget}`);
	if (v.wordy) parts.push(`${v.articles} articles in ${v.words} words`);
	return ` Last reply broke the voice: ${parts.join("; ")}. Cut it.`;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((c) => typeof c?.text === "string" && (c.type === undefined || c.type === "text" || c.type === "input_text")).map((c) => c.text).join("\n");
}

// Tool results that providers send in a user message: Anthropic tool_result, Gemini functionResponse.
const TOOL_PART = (c) => c?.type === "tool_result" || c?.functionResponse !== undefined;

// The human messages of a provider payload, with the key of their content array or string.
// Anthropic and OpenAI Chat: messages[] (content); OpenAI Responses: input[] (content);
// Gemini: contents[] (parts). OpenAI tool results have their own role or type, not user.
function humanMessages(payload) {
	const out = [];
	for (const [list, field] of [["messages", "content"], ["input", "content"], ["contents", "parts"]]) {
		const items = payload?.[list];
		if (!Array.isArray(items)) continue;
		for (const m of items) {
			if (m?.role !== "user") continue;
			const content = m[field];
			if (Array.isArray(content) ? content.some(TOOL_PART) : typeof content !== "string") continue;
			out.push({ message: m, field });
		}
	}
	return out;
}

// A stable key for a human message: its position among human messages and a hash of its text.
export function messageKey(text, index) {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return `${index}:${text.length}:${h}`;
}

function withLine(content, line, field) {
	if (typeof content === "string") return `${content}\n\n${line}`;
	if (field === "parts") return [...content, { text: line }];
	const type = content.some((c) => c?.type === "input_text") ? "input_text" : "text";
	return [...content, { type, text: line }];
}

/**
 * Adds a reminder line to each human message of a provider request, in place. `lines` maps a message
 * key to the line it got the first time; a message seen for the first time gets the base reminder,
 * and the newest one also gets `feedback`.
 * @returns {{ changed: boolean, fresh: boolean }} changed: a line was added; fresh: a new human
 *   message took its first line (the feedback is used)
 */
export function remind(payload, voice, lines, feedback = "") {
	const base = reminderText(voice);
	if (!base || !payload || typeof payload !== "object") return { changed: false, fresh: false };
	const humans = humanMessages(payload);
	let fresh = false;
	let changed = false;
	humans.forEach(({ message, field }, i) => {
		const text = textOf(message[field]);
		if (text.includes(MARK)) return;
		const key = messageKey(text, i);
		let line = lines.get(key);
		if (line === undefined) {
			line = i === humans.length - 1 ? base + feedback : base;
			lines.set(key, line);
			fresh = true;
		}
		message[field] = withLine(message[field], line, field);
		changed = true;
	});
	return { changed, fresh };
}

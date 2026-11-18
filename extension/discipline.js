// Keeps the voice for the whole session. The voice section sits at the start of the system prompt,
// far from the newest turn: in a long session with many tool calls, replies drift back to full prose.
// Two parts, both outside the stored conversation:
// 1. Remind: each human message that goes to the model carries a one-line reminder of the voice
//    (the `context` hook changes only the request, not the session file). The text of a message's
//    reminder never changes after it is first sent, so the prompt cache stays valid.
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
	return content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
}

// A stable key for a human message: its time when it has one, else its position and text.
export function messageKey(message, index) {
	if (message?.timestamp != null) return `t:${message.timestamp}`;
	const text = textOf(message?.content);
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return `i:${index}:${text.length}:${h}`;
}

function withLine(content, line) {
	if (typeof content === "string") return `${content}\n\n${line}`;
	if (Array.isArray(content)) return [...content, { type: "text", text: line }];
	return content;
}

// The messages with a reminder on each human message. `lines` maps a message key to the line it got
// the first time; a message seen for the first time gets the base reminder, and the newest one also
// gets `feedback`. Returns null when nothing changes.
export function remind(messages, voice, lines, feedback = "") {
	const base = reminderText(voice);
	if (!base || !Array.isArray(messages)) return null;
	let lastHuman = -1;
	messages.forEach((m, i) => {
		if (m?.role === "user") lastHuman = i;
	});
	if (lastHuman < 0) return null;
	return messages.map((m, i) => {
		if (m?.role !== "user") return m;
		const key = messageKey(m, i);
		let line = lines.get(key);
		if (line === undefined) {
			line = i === lastHuman ? base + feedback : base;
			lines.set(key, line);
		}
		if (textOf(m.content).includes(MARK)) return m;
		return { ...m, content: withLine(m.content, line) };
	});
}

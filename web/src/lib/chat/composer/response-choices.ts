export interface ResponseChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export interface ResponseChoiceQuestion {
	readonly id: string;
	readonly prompt: string;
	readonly options: readonly ResponseChoice[];
	readonly allowMultiple: boolean;
}

export interface ResponseChoiceSet {
	readonly questions: readonly ResponseChoiceQuestion[];
	readonly contentWithoutOptions: string;
}

export interface ResponseChoiceAnswer {
	readonly questionId: string;
	readonly selectedOptionIds: readonly string[];
}

const MAX_CONTENT_LENGTH = 12_000;
const MAX_OPTIONS = 10;
const MAX_LABEL_LENGTH = 1_200;
const MAX_PROMPT_LENGTH = 1_000;
const MAX_QUESTIONS = 10;

interface ChoiceLine {
	label: string;
	style: 'bullet' | 'number' | 'letter';
	position?: number;
	indent: number;
	checkbox: boolean;
}

export function allowsMultipleResponseChoices(content: string): boolean {
	return content.length <= MAX_CONTENT_LENGTH && /\b(?:(?:select|choose|pick)\s+(?:multiple|all that apply|one or more|more than one)|(?:select|choose|pick)\s+up to\s+(?:[2-9]|10))\b/i.test(content);
}

export function hasResponseChoiceLimit(content: string): boolean {
	return content.length <= MAX_CONTENT_LENGTH && /\b(?:select|choose|pick)\s+(?:(?:up to|at most|no more than|exactly)\s+)?(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(content);
}

function displayText(value: string): string {
	return value
		.trim()
		.replace(/^#{1,6}\s+/, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.trim();
}

function isChoicePrompt(value: string): boolean {
	if (!value || value.length > MAX_PROMPT_LENGTH) return false;
	if (allowsMultipleResponseChoices(value)) return true;
	if (/^(?:please\s+)?(?:choose|select|pick)\s+(?:an?\s+)?options?(?:\s+(?:above|below))?[.!:]?$/i.test(value)) return true;
	if (
		/^(?:please\s+)?(?:choose|select|pick)\b.*(?:one|option|answer|approach|path|following|:)\s*[:.!?]?$/i.test(
			value,
		)
	)
		return true;
	if (/\b(?:steps|instructions|commands)\b/i.test(value)) return false;
	return (
		/[?？]$/.test(value) &&
		/\b(?:which|prefer|choose|select|pick|would you like|do you want|should (?:I|we)|shall (?:I|we)|what would you|what do you|how would you (?:most )?like)\b/i.test(
			value,
		)
	);
}

export function isResponseChoiceReminder(content: string): boolean {
	if (content.length > MAX_PROMPT_LENGTH) return false;
	const prompt = displayText(content);
	return (
		!prompt.includes('\n') &&
		/^(?:please\s+)?(?:choose|select|pick)\b/i.test(prompt) &&
		isChoicePrompt(prompt)
	);
}

function choiceLine(line: string): ChoiceLine | null {
	const emphasis = /^( {0,3})(?:\*\*|__)/.exec(line);
	const source = emphasis ? emphasis[1] + displayText(line) : line;
	const match = /^( {0,3})(?:([-+*])\s+|(\d{1,2})[.)]\s+|([A-Za-z])[.)]\s+)(.+)$/.exec(source);
	if (!match) return null;
	const checkbox = /^\[[ xX]\]\s+/.test(match[5]);
	const label = displayText(match[5].replace(/^\[[ xX]\]\s+/, ''));
	if (!label || label.length > MAX_LABEL_LENGTH) return null;
	return {
		label,
		style: match[2] ? 'bullet' : match[3] ? 'number' : 'letter',
		position: match[3]
			? Number(match[3])
			: match[4]
				? match[4].toUpperCase().charCodeAt(0) - 64
				: undefined,
		indent: match[1].length,
		checkbox,
	};
}

interface ChoiceBlock {
	start: number;
	end: number;
	choices: ChoiceLine[];
	indices: number[];
}

interface NearbyPrompt {
	index: number;
	prompt: string;
}

function precedingPrompt(lines: readonly string[], start: number, boundary: number): NearbyPrompt | null {
	let fallback: NearbyPrompt | null = null;
	let inspected = 0;
	for (let index = start - 1; index >= boundary && inspected < 3; index--) {
		if (!lines[index].trim()) continue;
		inspected++;
		const prompt = displayText(lines[index]);
		if (isChoicePrompt(prompt)) {
			if (/[?？]$/.test(prompt)) return { index, prompt };
			fallback ??= { index, prompt };
			continue;
		}
		if (!/^(?:your\s+)?(?:options|choices)(?:\s+are)?\s*:?$/i.test(prompt)) break;
	}
	return fallback;
}

function adjacentPrompt(lines: readonly string[], block: ChoiceBlock, before: NearbyPrompt | null, afterBoundary: number): NearbyPrompt | null {
	const after = lines.slice(block.end + 1, afterBoundary).filter((line) => line.trim());
	// A later question or substantial prose makes an earlier list ambiguous.
	if (after.length > 2 || after.join('\n').length > MAX_PROMPT_LENGTH) return null;
	if (after.some((line) => /^(?:\s*(?:[-+*]\s|\d+[.)]\s|[A-Za-z][.)]\s|>|\|)| {4}|\t)/.test(line)))
		return null;
	const trailingQuestion = after.findLast((line) => /[?？]/.test(line));
	if (trailingQuestion) {
		const prompt = displayText(trailingQuestion);
		return isChoicePrompt(prompt) ? { index: lines.indexOf(trailingQuestion, block.end + 1), prompt } : null;
	}
	const trailingPrompt = after.findLast((line) => isChoicePrompt(displayText(line)));
	return before ?? (trailingPrompt ? { index: lines.indexOf(trailingPrompt, block.end + 1), prompt: displayText(trailingPrompt) } : null);
}

// Bounds work and refuses Markdown structures whose list meaning is ambiguous.
export function parseResponseChoices(content: string): ResponseChoiceSet | null {
	if (content.length > MAX_CONTENT_LENGTH || !content.trim()) return null;
	if (/^\s*(?:`{3,}|~{3,}|\|)/m.test(content)) return null;
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	const blocks: ChoiceBlock[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (!/^\s*[-+*]\s/.test(lines[index]) && /[?？]$/.test(displayText(lines[index])) && isChoicePrompt(displayText(lines[index]))) continue;
		const first = choiceLine(lines[index]);
		if (!first) continue;
		const start = index;
		const choices = [first];
		const indices = [index];
		let end = index;
		for (let next = index + 1; next < lines.length; next++) {
			if (!lines[next].trim()) continue;
			if (!/^\s*[-+*]\s/.test(lines[next]) && /[?？]$/.test(displayText(lines[next])) && isChoicePrompt(displayText(lines[next]))) break;
			const choice = choiceLine(lines[next]);
			if (!choice || choice.style !== first.style || choice.indent !== first.indent || choice.checkbox !== first.checkbox) break;
			choices.push(choice);
			indices.push(next);
			end = next;
		}
		blocks.push({ start, end, choices, indices });
		index = end;
	}
	const leading = blocks.map((block, index) => precedingPrompt(lines, block.start, index ? blocks[index - 1].end + 1 : 0));
	const questions: ResponseChoiceQuestion[] = [];
	const removed = new Set<number>();
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		const { choices } = block;
		if (choices.length < 2 || choices.length > MAX_OPTIONS) continue;
		if (choices.some((choice, position) => choice.position !== undefined && choice.position !== position + 1)) continue;
		if (new Set(choices.map(choice => choice.label)).size !== choices.length) continue;
		const afterBoundary = leading[index + 1]?.index ?? lines.length;
		const prompt = adjacentPrompt(lines, block, leading[index], afterBoundary);
		if (!prompt) continue;
		const cueStart = Math.min(prompt.index, block.start);
		const cues = lines.slice(cueStart, afterBoundary).filter((_line, offset) => !block.indices.includes(cueStart + offset)).join('\n');
		if (hasResponseChoiceLimit(cues)) continue;
		questions.push({
			id: `question-${questions.length + 1}`,
			prompt: prompt.prompt,
			allowMultiple: choices.every(choice => choice.checkbox) || allowsMultipleResponseChoices(cues),
			options: choices.map((choice, position) => ({ id: `option-${position + 1}`, label: choice.label })),
		});
		if (questions.length > MAX_QUESTIONS) return null;
		for (const line of block.indices) removed.add(line);
	}
	if (!questions.length) return null;
	return {
		questions,
		contentWithoutOptions: lines.filter((_line, index) => !removed.has(index)).join('\n'),
	};
}

export function formatResponseChoiceAnswers(questions: readonly ResponseChoiceQuestion[], answers: readonly ResponseChoiceAnswer[]): string | null {
	if (!questions.length || questions.length > 100 || answers.length !== questions.length) return null;
	const questionIds = new Set(questions.map(question => question.id));
	if (questionIds.size !== questions.length) return null;
	const answerById = new Map<string, ResponseChoiceAnswer>();
	for (const answer of answers) {
		if (!questionIds.has(answer.questionId) || answerById.has(answer.questionId)) return null;
		answerById.set(answer.questionId, answer);
	}
	const formatted: string[] = [];
	for (const question of questions) {
		if (!question.id.trim() || !question.prompt.trim() || question.prompt.length > MAX_PROMPT_LENGTH
			|| question.options.length < 2 || question.options.length > MAX_OPTIONS
			|| question.options.some(option => !option.id.trim() || !option.label.trim() || option.label.length > MAX_LABEL_LENGTH)) return null;
		const selected = answerById.get(question.id)?.selectedOptionIds;
		if (!selected?.length || selected.length > MAX_OPTIONS || (!question.allowMultiple && selected.length !== 1)) return null;
		if (new Set(selected).size !== selected.length || new Set(question.options.map(option => option.id)).size !== question.options.length) return null;
		const labels: string[] = [];
		for (const optionId of selected) {
			const option = question.options.find(option => option.id === optionId);
			if (!option) return null;
			labels.push(option.label);
		}
		const answer = labels.length === 1 ? labels[0] : labels.map(label => `- ${label}`).join('\n');
		formatted.push(questions.length === 1 ? answer : `${question.prompt}\n${answer}`);
	}
	return formatted.join('\n\n');
}

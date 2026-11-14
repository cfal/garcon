import { describe, expect, it } from 'vitest';
import {
	parseResponseChoices as parseChoiceSet,
	formatResponseChoiceAnswers,
	type ResponseChoiceQuestion,
	type ResponseChoiceAnswer,
} from '$lib/chat/composer/response-choices.js';

function parseResponseChoices(content: string) {
	return parseChoiceSet(content)?.questions[0] ?? null;
}

describe('parseResponseChoices', () => {
	it.each(['- ', '* ', '+ ', '1. ', '1) ', 'A. ', 'A) '])(
		'recognizes a direct choice question with %s markers',
		(first) => {
			const second = first.replace('1', '2').replace('A', 'B');
			expect(
				parseResponseChoices(`Which layout do you prefer?\n\n${first}Compact\n${second}Spacious`),
			).toEqual({
				id: 'question-1',
				prompt: 'Which layout do you prefer?',
				allowMultiple: false,
				options: [
					{ id: 'option-1', label: 'Compact' },
					{ id: 'option-2', label: 'Spacious' },
				],
			});
		},
	);

	it('preserves recommendations and descriptions while removing bold display wrappers', () => {
		expect(
			parseResponseChoices(
				'**Which layout should we use?**\n1. **Compact (Recommended)** — Fits smaller screens\n2. __Spacious__ — More room between items',
			)?.options,
		).toEqual([
			{ id: 'option-1', label: 'Compact (Recommended) — Fits smaller screens' },
			{ id: 'option-2', label: 'Spacious — More room between items' },
		]);
	});

	it('accepts bold labels that include letter markers', () => {
		expect(
			parseResponseChoices('Which layout do you prefer?\n**A. Compact**\n**B. Spacious**')?.options,
		).toEqual([
			{ id: 'option-1', label: 'Compact' },
			{ id: 'option-2', label: 'Spacious' },
		]);
	});

	it('accepts an explicit imperative and an optional choices heading', () => {
		expect(
			parseResponseChoices('Please choose one:\n\nOptions:\n- Compact\n\n- Spacious')?.prompt,
		).toBe('Please choose one:');
	});

	it('uses a final question after the options', () => {
		expect(
			parseResponseChoices(
				'Available layouts:\n- Compact\n- Spacious\n\nWhich option do you prefer?',
			)?.prompt,
		).toBe('Which option do you prefer?');
	});

	it('retains each clearly marked question and its own choice list', () => {
		const result = parseChoiceSet(
			'Which format should we use?\n- Text\n- JSON\n\nWhich layout do you prefer?\nA) Compact\nB) Spacious',
		);
		expect(result?.questions.map(question => question.prompt)).toEqual(['Which format should we use?', 'Which layout do you prefer?']);
		expect(result?.questions[1].options.map((option) => option.label)).toEqual(['Compact', 'Spacious']);
	});

	it('recognizes a preference question before three choices and a custom-answer footer', () => {
		const result = parseResponseChoices(
			'Pick your preferred way to review a sample.\n\nHow would you most like to review a sample?\n\n- Read a short outline\n- Compare a diagram\n- Try an example\n\nChoose an option above, or type your own answer.',
		);
		expect(result).toEqual({
			id: 'question-1',
			prompt: 'How would you most like to review a sample?',
			allowMultiple: false,
			options: [
				{ id: 'option-1', label: 'Read a short outline' },
				{ id: 'option-2', label: 'Compare a diagram' },
				{ id: 'option-3', label: 'Try an example' },
			],
		});
	});

	it('recognizes a how-would-you-like preference without an intensifier', () => {
		expect(
			parseResponseChoices('How would you like to review a sample?\n- Outline\n- Example')?.prompt,
		).toBe('How would you like to review a sample?');
	});

	it('keeps the actual question as the prompt when a selection reminder follows the list', () => {
		expect(
			parseResponseChoices(
				'Which layout do you prefer?\n- Compact\n- Spacious\n\nChoose an option above, or type your own answer.',
			)?.prompt,
		).toBe('Which layout do you prefer?');
	});

	it('can use an explicit selection footer when no preceding question exists', () => {
		expect(
			parseResponseChoices(
				'Available layouts:\n- Compact\n- Spacious\n\nChoose an option above, or type your own answer.',
			)?.options,
		).toHaveLength(2);
	});

	it('accepts CRLF and a short trailing recommendation', () => {
		expect(
			parseResponseChoices(
				'Which layout do you prefer?\r\n1. Compact\r\n2. Spacious\r\n\r\nCompact is the default.',
			)?.options,
		).toHaveLength(2);
	});

	it.each([
		'',
		'Which layout do you prefer?',
		'Which layout do you prefer? Compact or spacious?',
		'Which layout do you prefer?\n- Compact',
		'Changes made:\n1. Updated styling\n2. Added tests',
		'How do I install the app?\n1. Download the archive\n2. Extract the files',
		'How would you install the app?\n1. Download the archive\n2. Extract the files',
		'How would you most efficiently install the app?\n1. Download the archive\n2. Extract the files',
		'Which steps should I follow?\n1. Download the archive\n2. Extract the files',
		'Tasks to complete:\n- [ ] Download the archive\n- [x] Extract the files',
		'Which layout do you prefer?\n    1. Compact\n    2. Spacious',
		'Which layout do you prefer?\n1. Compact\n3. Spacious',
		'Which layout do you prefer?\nA) Compact\nC) Spacious',
		'Which layout do you prefer?\n- Compact\n2. Spacious',
		'Which layout do you prefer?\n- Compact\n- Compact',
		'Which layout do you prefer?\n- Compact\n- Spacious\n\nWhat is your project called?',
		'Available layouts:\n- Compact\n- Spacious\nWhich option do you prefer?\nWhat is your project called?',
		'Which layout do you prefer?\n- Compact\n- Spacious\n- [ ] Custom',
		'Which layout do you prefer?\n- Compact\n  - Nested option\n- Spacious',
		'Which layout do you prefer?\nUnrelated explanation.\n- Compact\n- Spacious',
		'Which layout do you prefer?\n- Compact\n- Spacious\n\nParagraph one.\nParagraph two.\nParagraph three.',
		'```text\nWhich layout do you prefer?\n- Compact\n- Spacious\n```',
		'~~~text\nWhich layout do you prefer?\n- Compact\n- Spacious\n~~~',
		'Which layout do you prefer?\n| Option | Detail |\n|---|---|\n| A | Compact |\n| B | Spacious |',
	])('rejects absent or ambiguous choices: %s', (content) => {
		expect(parseResponseChoices(content)).toBeNull();
	});

	it('rejects oversized content and option counts', () => {
		expect(
			parseResponseChoices(
				`${'x'.repeat(12_000)}\nWhich layout do you prefer?\n- Compact\n- Spacious`,
			),
		).toBeNull();
		expect(
			parseResponseChoices(
				`Choose one:\n${Array.from({ length: 11 }, (_, index) => `${index + 1}. Option ${index + 1}`).join('\n')}`,
			),
		).toBeNull();
		expect(
			parseResponseChoices(
				`Choose one:\n${Array.from({ length: 11 }, (_, index) => `${String.fromCharCode(65 + index)}) Option ${index + 1}`).join('\n')}`,
			),
		).toBeNull();
	});

	it('rejects overly long prompts and labels', () => {
		expect(parseResponseChoices(`Which ${'x'.repeat(1_000)}?\n- Compact\n- Spacious`)).toBeNull();
		expect(
			parseResponseChoices(`Which layout do you prefer?\n- ${'x'.repeat(1_201)}\n- Spacious`),
		).toBeNull();
	});

	it('keeps positional IDs deterministic', () => {
		const content = 'Pick one:\n1. Compact\n2. Spacious';
		expect(parseResponseChoices(content)).toEqual(parseResponseChoices(content));
	});

	it.each(['Select multiple.', 'Choose all that apply.', 'Select all that apply.', 'Choose one or more.', 'Choose more than one.'])(
		'permits multiple answers only with an explicit selection cue: %s', (cue) => {
			expect(parseResponseChoices(`Which features do you want?\n${cue}\n- Search\n- Export`)?.allowMultiple).toBe(true);
		},
	);
	it('leaves capped selections in their original text rather than offering unrestricted choices', () => {
		expect(parseChoiceSet('Which features do you want?\nSelect up to 2.\n- Search\n- Export\n- Preview')).toBeNull();
	});
	it('recognizes options phrased as questions', () => {
		expect(parseChoiceSet('Which approach do you prefer?\n- Should we use a concise outline?\n- Should we use a detailed example?')?.questions[0].options).toHaveLength(2);
	});

	it('does not infer multiple selection from an option label or a plain plural question', () => {
		expect(parseResponseChoices('Which features do you want?\n- Search\n- Export')?.allowMultiple).toBe(false);
		expect(parseResponseChoices('Which action do you prefer?\n- Select multiple items\n- Select one item')?.allowMultiple).toBe(false);
	});

	it('treats a choice question with checkbox options as multiple selection', () => {
		expect(parseResponseChoices('Which features do you want?\n- [ ] Search\n- [x] Export')).toMatchObject({
			allowMultiple: true,
			options: [{ id: 'option-1', label: 'Search' }, { id: 'option-2', label: 'Export' }],
		});
	});

	it('removes only detected option lines while retaining surrounding prose and question headings', () => {
		const content = 'Review preferences.\n\n1. Which format do you prefer?\n- Outline\n- Diagram\n\n2. Which features do you want?\nSelect multiple.\n- Search\n- Export\n\nChoose an option above, or type your own answer.';
		const result = parseChoiceSet(content);
		expect(result?.questions).toMatchObject([
			{ id: 'question-1', prompt: '1. Which format do you prefer?', allowMultiple: false },
			{ id: 'question-2', prompt: '2. Which features do you want?', allowMultiple: true },
		]);
		expect(result?.contentWithoutOptions).toBe('Review preferences.\n\n1. Which format do you prefer?\n\n2. Which features do you want?\nSelect multiple.\n\nChoose an option above, or type your own answer.');
	});

	it('bounds the number of questions per assistant row', () => {
		const content = Array.from({ length: 11 }, (_, index) => `Which format ${index + 1} do you prefer?\n- Outline\n- Diagram`).join('\n\n');
		expect(parseChoiceSet(content)).toBeNull();
	});
});

describe('formatResponseChoiceAnswers', () => {
	const questions: readonly ResponseChoiceQuestion[] = [
		{ id: 'format', prompt: 'Which format do you prefer?', allowMultiple: false, options: [{ id: 'outline', label: 'Outline (Recommended)' }, { id: 'diagram', label: 'Diagram' }] },
		{ id: 'features', prompt: 'Which features do you want?', allowMultiple: true, options: [{ id: 'search', label: 'Search' }, { id: 'export', label: 'Export' }] },
	];
	const complete: readonly ResponseChoiceAnswer[] = [
		{ questionId: 'format', selectedOptionIds: ['outline'] },
		{ questionId: 'features', selectedOptionIds: ['search', 'export'] },
	];

	it('returns the original label for one question and one selected choice', () => {
		expect(formatResponseChoiceAnswers(questions.slice(0, 1), complete.slice(0, 1))).toBe('Outline (Recommended)');
	});

	it('formats multiple selected choices as readable lines', () => {
		expect(formatResponseChoiceAnswers(questions.slice(1), complete.slice(1))).toBe('- Search\n- Export');
	});

	it('includes every question prompt and validates answers independently of supplied question order', () => {
		expect(formatResponseChoiceAnswers(questions, [...complete].reverse())).toBe('Which format do you prefer?\nOutline (Recommended)\n\nWhich features do you want?\n- Search\n- Export');
	});

	it.each(([
		[],
		[{ questionId: 'format', selectedOptionIds: ['outline'] }],
		[{ questionId: 'format', selectedOptionIds: [] }, complete[1]],
		[{ questionId: 'format', selectedOptionIds: ['outline', 'diagram'] }, complete[1]],
		[complete[0], { questionId: 'features', selectedOptionIds: ['search', 'search'] }],
		[complete[0], { questionId: 'features', selectedOptionIds: ['unknown'] }],
		[complete[0], { questionId: 'unknown', selectedOptionIds: ['search'] }],
		[complete[0], complete[0]],
		[...complete, complete[0]],
	] satisfies readonly (readonly ResponseChoiceAnswer[])[]).map(answers => ({ answers })))('rejects missing, duplicate, unknown, or disallowed answers: %j', ({ answers }) => {
		expect(formatResponseChoiceAnswers(questions, answers)).toBeNull();
	});

	it('rejects malformed question definitions', () => {
		expect(formatResponseChoiceAnswers([], [])).toBeNull();
		expect(formatResponseChoiceAnswers([questions[0], questions[0]], complete)).toBeNull();
		expect(formatResponseChoiceAnswers([{ ...questions[0], options: [questions[0].options[0], questions[0].options[0]] }], complete.slice(0, 1))).toBeNull();
		expect(formatResponseChoiceAnswers([{ ...questions[0], options: [] }], complete.slice(0, 1))).toBeNull();
	});
});

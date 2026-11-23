import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditToolUseMessage } from '../../common/chat-types.js';
import {
	buildChatToolDiff,
	type ChatToolDiff,
} from '../src/lib/components/chat/tools/content/chat-tool-diff.js';

// Takes an unmodified stock chat-tool-diff.ts and runs both implementations on the same inputs.
const stockPath = process.argv[2];
if (!stockPath)
	throw new Error('Usage: bun web/scripts/benchmark-chat-tool-diff.ts <stock-module-path>');
const { buildChatToolDiff: stock }: { buildChatToolDiff: typeof buildChatToolDiff } = await import(
	pathToFileURL(resolve(stockPath)).href
);

function inspect(run: () => ChatToolDiff) {
	// Both implementations initialize each matrix row with fill(0). Timing runs without this hook.
	const fill = Array.prototype.fill;
	let cells = 0;
	try {
		Array.prototype.fill = function (...args) {
			cells += this.length;
			return fill.apply(this, args);
		};
		return { result: run(), cells };
	} finally {
		Array.prototype.fill = fill;
	}
}

function sample(run: () => ChatToolDiff) {
	const calls = 8;
	const start = performance.now();
	for (let i = 0; i < calls; i += 1) assert.equal(run().kind, 'ready');
	return (performance.now() - start) / calls;
}

const median = (samples: number[]) =>
	Number(samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(3));
for (const edit of ['ordinary', 'head', 'middle', 'end', 'both-ends', 'disjoint']) {
	const length = edit === 'ordinary' ? 20 : 450;
	const lines = Array.from({ length }, (_, i) => `const component${i} = makeComponent(${i});`);
	const index = edit === 'head' ? 0 : edit === 'end' ? length - 1 : Math.floor(length / 2);
	let revised = lines.with(index, 'const replacement = changed();');
	if (edit === 'both-ends')
		revised = lines.with(0, 'const first = changed();').with(-1, 'const last = changed();');
	if (edit === 'disjoint') revised = lines.map((line) => '// ' + line);
	const message = new EditToolUseMessage(
		'2026-01-01T00:00:00Z',
		'edit',
		'/project/example.ts',
		lines.join('\n'),
		revised.join('\n'),
	);
	const before = () => stock(message.oldString!, message.newString!);
	const after = () => buildChatToolDiff(message.oldString!, message.newString!);
	const baseline = inspect(before);
	const candidate = inspect(after);
	assert.deepEqual(candidate.result, baseline.result);
	assert.equal(baseline.cells, (length + 1) ** 2, 'Expected stock to initialize the full matrix');
	assert(
		candidate.cells > 0 && candidate.cells <= baseline.cells,
		'Expected bounded fill-based rows',
	);
	if (edit !== 'both-ends' && edit !== 'disjoint') assert(candidate.cells <= 4);
	sample(before);
	sample(after);
	const oldTimes: number[] = [];
	const newTimes: number[] = [];
	for (let i = 0; i < 7; i += 1) {
		if (i % 2 === 0) oldTimes.push(sample(before));
		newTimes.push(sample(after));
		if (i % 2 !== 0) oldTimes.push(sample(before));
	}
	console.log({
		edit,
		stockCells: baseline.cells,
		candidateCells: candidate.cells,
		stockMs: median(oldTimes),
		candidateMs: median(newTimes),
	});
}

const words = ['', 'a', 'b'];
let sequences = words;
const cases = [...sequences];
for (let length = 2; length <= 4; length += 1) {
	sequences = sequences.flatMap((prefix) => words.map((word) => prefix + '\n' + word));
	cases.push(...sequences);
}
for (const before of cases) {
	for (const after of cases)
		assert.deepEqual(buildChatToolDiff(before, after), stock(before, after));
}
console.log({ exactDiffComparisons: cases.length ** 2 });

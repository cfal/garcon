import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { composerMarkdownCodec } from '../src/lib/components/chat/composer/composer-markdown-codec.js';
import { createTextProtection } from '../src/lib/components/chat/composer/composer-markdown-text.js';

// Compares the complete edited-block codec, not the parser or native key latency.
const stockRoot = process.argv[2];
if (!stockRoot) throw new Error('Usage: bun web/scripts/benchmark-composer-labels.ts <stock-tree>');
const moduleUrl = (file: string) =>
	pathToFileURL(resolve(stockRoot, 'web/src/lib/components/chat/composer', file)).href;
const { composerMarkdownCodec: stock }: { composerMarkdownCodec: typeof composerMarkdownCodec } =
	await import(moduleUrl('composer-markdown-codec.ts'));
const { createTextProtection: stockProtection }: { createTextProtection: typeof createTextProtection } =
	await import(moduleUrl('composer-markdown-text.ts'));

const oldRules = stockProtection('')!;
const newRules = createTextProtection('')!;
const alphabet = ['[', ']', '(', ':', 'x', '~', '*', '\u00a0'];
let inputs = [''];
let checked = 0;
for (let length = 1; length <= 4; length++) {
	inputs = inputs.flatMap((prefix) => alphabet.map((char) => prefix + char));
	for (const input of inputs) {
		for (const lineStart of [false, true]) {
			for (const link of [false, true]) {
				const context = { lineStart, link };
				assert.equal(newRules.prose(input, context), oldRules.prose(input, context));
				checked++;
			}
		}
	}
}
console.log({ exactProtectionComparisons: checked });

for (const length of [250, 4_000, 24_000]) {
	for (const [label, unit] of [
		['ordinary', 'Check the work_queue & path [0] here. '],
		['unfinished', 'begin [field [value [lookup '],
	]) {
		const text = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
		const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
		const reference = stock.serialize(document);
		assert.equal(composerMarkdownCodec.serialize(document), reference);
		const samples: number[][] = [[], []];
		for (let pair = 0; pair < 10; pair++) {
			for (const arm of pair % 2 === 0 ? [0, 1] : [1, 0]) {
				const codec = arm ? composerMarkdownCodec : stock;
				const start = performance.now();
				const actual = codec.serialize(document);
				const elapsed = performance.now() - start;
				assert.equal(actual, reference);
				if (pair) samples[arm].push(elapsed);
			}
		}
		const [stockMs, candidateMs] = samples.map((times) => +times.sort((a, b) => a - b)[4].toFixed(3));
		console.log({ label, length, stockMs, candidateMs });
	}
}

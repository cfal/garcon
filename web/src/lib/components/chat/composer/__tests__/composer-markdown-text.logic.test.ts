import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextProtection, MarkdownPrivateUseCharacters } from '../composer-markdown-text.js';

afterEach(() => vi.restoreAllMocks());

describe('Markdown private-use characters', () => {
	it('collects text and nested node/mark attributes without scanning object keys', () => {
		const characters = new MarkdownPrivateUseCharacters();
		expect(characters.scan({
			text: 'text\ue000',
			attrs: { nested: ['\ue001', null, 1, false], '\ue004': 'ordinary' },
			marks: [{ attrs: { href: 'https://example.test/\ue002', title: '\ue003' } }],
		})).toBe(true);
		expect([...characters.used]).toEqual([0xe000, 0xe001, 0xe002, 0xe003]);
		expect(characters.scan('ordinary')).toBe(false);
		expect(characters.scan('ordinary')).toBe(false);
	});
	it('scans each repeated destination only once, even across distinct attribute objects', () => {
		const destination = 'https://example.test/' + 'x'.repeat(16_000) + '\ue000';
		const attributes = Array.from({ length: 1_500 }, () => ({ href: destination }));
		const characters = new MarkdownPrivateUseCharacters();
		const characterAt = vi.spyOn(String.prototype, 'charCodeAt');
		const found = characters.scan(attributes);
		const repeated = characters.scan(attributes);
		const scannedUnits = characterAt.mock.calls.length;
		characterAt.mockRestore();
		expect(found).toBe(true);
		expect(repeated).toBe(true);
		expect(scannedUnits).toBe(destination.length);
		expect([...characters.used]).toEqual([0xe000]);
	});
	it('restores protected punctuation without changing resource attributes', () => {
		const protection = createTextProtection({
			type: 'image', attrs: { src: 'https://example.test/\ue000', title: '\ue001' },
		});
		expect(protection).not.toBeNull();
		const source = 'my_var [label](https://example.test/\ue000 "\ue001")';
		expect(protection!.restore(protection!.verbatim(source))).toBe(source);
	});
	it('falls back when attributes occupy the full sentinel range', () => {
		const privateUse = String.fromCharCode(...Array.from({ length: 0x1900 }, (_, i) => 0xe000 + i));
		expect(createTextProtection({ type: 'image', attrs: { src: privateUse } })).toBeNull();
	});
});

import { afterEach, expect, it, vi } from 'vitest';
import { TerminalOutputFragments } from '../terminal-output-fragments.js';

afterEach(() => vi.useRealTimers());

const fragment = (fragmentIndex: number, dataBase64: string, fragmentCount = 2) => ({
	type: 'terminal-output-fragment' as const,
	terminalId: 'synthetic-terminal',
	sequence: 1,
	fragmentIndex,
	fragmentCount,
	dataBase64,
});

it('decodes Unicode only after the complete bounded sequence', () => {
	const fragments = new TerminalOutputFragments(vi.fn());
	const encoded = btoa(String.fromCharCode(...new TextEncoder().encode('hello \u4e16\u754c')));
	expect(fragments.append(fragment(0, encoded.slice(0, 5)))).toBeNull();
	expect(fragments.append(fragment(1, encoded.slice(5)))).toBe('hello \u4e16\u754c');
});

it('rejects gaps, excessive counts and bytes, then accepts a fresh sequence', () => {
	const fragments = new TerminalOutputFragments(vi.fn());
	expect(() => fragments.append(fragment(1, ''))).toThrow();
	expect(() => fragments.append(fragment(0, '', 257))).toThrow();
	expect(() => fragments.append(fragment(0, 'a'.repeat(2 * 1024 * 1024 + 1)))).toThrow();
	fragments.append(fragment(0, 'YQ'));
	expect(() => fragments.append(fragment(0, '=='))).toThrow();
	expect(fragments.append(fragment(0, 'YQ==', 1))).toBe('a');
	fragments.clear();
});

it('expires incomplete output and cancels expiration on replacement or disposal', () => {
	vi.useFakeTimers();
	const expired = vi.fn();
	const fragments = new TerminalOutputFragments(expired);
	fragments.append(fragment(0, 'YQ'));
	vi.advanceTimersByTime(30_000);
	expect(expired).toHaveBeenCalledExactlyOnceWith('synthetic-terminal');
	fragments.append(fragment(0, 'YQ'));
	fragments.delete('synthetic-terminal');
	fragments.append(fragment(0, 'YQ'));
	fragments.clear();
	vi.advanceTimersByTime(30_000);
	expect(expired).toHaveBeenCalledOnce();
});

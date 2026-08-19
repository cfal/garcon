import { describe, expect, it } from 'vitest';
import {
	MAX_CUSTOM_COMPLETION_SOUND_BYTES,
	shouldPlayCompletionSound,
	validateCustomCompletionSound,
} from '../completion-sound';

function file(name: string, type: string, size: number): Pick<File, 'name' | 'size' | 'type'> {
	return { name, type, size };
}

describe('completion sound', () => {
	it('accepts supported audio types and extensions', () => {
		expect(validateCustomCompletionSound(file('done.mp3', 'audio/mpeg', 100))).toBeNull();
		expect(validateCustomCompletionSound(file('done.wav', '', 100))).toBeNull();
		expect(validateCustomCompletionSound(file('DONE.OGG', '', 100))).toBeNull();
	});

	it('rejects empty, oversized, and unsupported files', () => {
		expect(validateCustomCompletionSound(file('done.mp3', 'audio/mpeg', 0))).toBe('empty');
		expect(
			validateCustomCompletionSound(
				file('done.mp3', 'audio/mpeg', MAX_CUSTOM_COMPLETION_SOUND_BYTES + 1),
			),
		).toBe('too-large');
		expect(validateCustomCompletionSound(file('done.txt', 'text/plain', 100))).toBe(
			'unsupported-type',
		);
		expect(validateCustomCompletionSound(file('done.mp3', 'text/plain', 100))).toBe(
			'unsupported-type',
		);
	});

	it('honors disabled and focus-aware playback preferences', () => {
		expect(
			shouldPlayCompletionSound({ mode: 'off', volume: 1, visibility: 'always' }, 'hidden', false),
		).toBe(false);
		expect(
			shouldPlayCompletionSound(
				{ mode: 'default', volume: 1, visibility: 'unfocused' },
				'visible',
				true,
			),
		).toBe(false);
		expect(
			shouldPlayCompletionSound(
				{ mode: 'default', volume: 1, visibility: 'unfocused' },
				'visible',
				false,
			),
		).toBe(true);
		expect(
			shouldPlayCompletionSound(
				{ mode: 'default', volume: 1, visibility: 'unfocused' },
				'hidden',
				true,
			),
		).toBe(true);
		expect(
			shouldPlayCompletionSound(
				{ mode: 'default', volume: 1, visibility: 'always' },
				'visible',
				true,
				true,
			),
		).toBe(true);
	});

	it('allows test playback to override the disabled mode', () => {
		expect(
			shouldPlayCompletionSound(
				{ mode: 'off', volume: 1, visibility: 'unfocused' },
				'visible',
				true,
				true,
			),
		).toBe(true);
	});
});

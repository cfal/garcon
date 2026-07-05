import { describe, expect, it } from 'vitest';

import { hasEscapeOwningLayer, shouldHandleGlobalEscapeAbort } from '../escape-abort-guard';

function keyboardEvent(options: KeyboardEventInit = {}): KeyboardEvent {
	return new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...options });
}

describe('escape abort guard', () => {
	it('allows a plain Escape event to abort', () => {
		const doc = document.implementation.createHTMLDocument();

		expect(shouldHandleGlobalEscapeAbort(keyboardEvent(), doc)).toBe(true);
	});

	it('ignores handled Escape events', () => {
		const doc = document.implementation.createHTMLDocument();
		const event = keyboardEvent();

		event.preventDefault();

		expect(shouldHandleGlobalEscapeAbort(event, doc)).toBe(false);
	});

	it('ignores Escape while another layer owns dismissal', () => {
		const doc = document.implementation.createHTMLDocument();
		const dialog = doc.createElement('div');
		dialog.setAttribute('role', 'dialog');
		doc.body.append(dialog);

		expect(hasEscapeOwningLayer(doc)).toBe(true);
		expect(shouldHandleGlobalEscapeAbort(keyboardEvent(), doc)).toBe(false);
	});

	it('ignores repeated Escape events', () => {
		const doc = document.implementation.createHTMLDocument();

		expect(shouldHandleGlobalEscapeAbort(keyboardEvent({ repeat: true }), doc)).toBe(false);
	});
});

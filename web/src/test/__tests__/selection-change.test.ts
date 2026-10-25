import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferDocumentSelectionChanges } from '../selection-change.js';

const onChange = vi.fn();
let restore: () => void;
let text: Text;

beforeEach(() => {
	vi.useFakeTimers();
	onChange.mockReset();
	text = document.createTextNode('synthetic selection');
	document.body.append(text);
	restore = deferDocumentSelectionChanges();
	document.addEventListener('selectionchange', onChange);
});

afterEach(() => {
	document.removeEventListener('selectionchange', onChange);
	restore();
	text.remove();
	vi.useRealTimers();
});

it('coalesces synchronous selection mutations onto a later task', () => {
	document.getSelection()!.collapse(text, 0);
	document.getSelection()!.collapse(text, 1);
	expect(onChange).not.toHaveBeenCalled();
	vi.runAllTimers();
	expect(onChange).toHaveBeenCalledTimes(1);
	expect(document.getSelection()!.anchorOffset).toBe(1);
});

it('schedules a new task when a listener changes the selection', () => {
	onChange.mockImplementationOnce(() => document.getSelection()!.collapse(text, 2));
	document.getSelection()!.collapse(text, 0);
	vi.advanceTimersToNextTimer();
	expect(onChange).toHaveBeenCalledTimes(1);
	vi.advanceTimersToNextTimer();
	expect(onChange).toHaveBeenCalledTimes(2);
});

it('preserves synchronous delivery and cancellation for other events', () => {
	document.addEventListener('synthetic-event', (event) => event.preventDefault(), { once: true });
	expect(document.dispatchEvent(new Event('synthetic-event', { cancelable: true }))).toBe(false);
});

it('cancels pending delivery and restores the original dispatcher', () => {
	document.getSelection()!.collapse(text, 0);
	restore();
	vi.runAllTimers();
	expect(onChange).not.toHaveBeenCalled();
	document.getSelection()!.collapse(text, 1);
	expect(onChange).toHaveBeenCalledTimes(1);
});

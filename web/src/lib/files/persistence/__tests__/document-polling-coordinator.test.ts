import { describe, expect, it, vi } from 'vitest';
import { DocumentPollingCoordinator } from '$lib/files/persistence/document-polling-coordinator.js';

function documentTarget() {
	let visibilityState: DocumentVisibilityState = 'visible';
	const listeners = new Set<EventListenerOrEventListenerObject>();
	return {
		get visibilityState() {
			return visibilityState;
		},
		setVisibility(next: DocumentVisibilityState) {
			visibilityState = next;
			for (const listener of listeners) {
				if (typeof listener === 'function') listener(new Event('visibilitychange'));
				else listener.handleEvent(new Event('visibilitychange'));
			}
		},
		addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
			listeners.add(listener);
		},
		removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
			listeners.delete(listener);
		},
	};
}

describe('DocumentPollingCoordinator', () => {
	it('polls one document regardless of how many views reference it', async () => {
		const poll = vi.fn(async () => undefined);
		const target = documentTarget();
		const coordinator = new DocumentPollingCoordinator({
			poll,
			isVisible: () => true,
			documentTarget: target,
		});

		coordinator.add('document');
		coordinator.add('document');
		await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
		coordinator.destroy();
	});

	it('checks immediately after a hidden document becomes visible', async () => {
		const poll = vi.fn(async () => undefined);
		const target = documentTarget();
		target.setVisibility('hidden');
		const coordinator = new DocumentPollingCoordinator({
			poll,
			isVisible: () => true,
			documentTarget: target,
		});
		coordinator.add('document');
		expect(poll).not.toHaveBeenCalled();

		target.setVisibility('visible');
		await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
		coordinator.destroy();
	});
});

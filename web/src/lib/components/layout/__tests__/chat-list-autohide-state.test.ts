import { afterEach, describe, expect, it } from 'vitest';
import { ChatListAutohideState } from '../chat-list-autohide-state.svelte.js';

function createState(initiallyActive = true) {
	let active = initiallyActive;
	const autohide = new ChatListAutohideState({
		get active() {
			return active;
		},
	});
	return {
		autohide,
		setActive(value: boolean) {
			active = value;
		},
	};
}

describe('ChatListAutohideState', () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it('reveals and collapses only while autohide is active', () => {
		const harness = createState();

		expect(harness.autohide.collapsed).toBe(true);
		harness.autohide.reveal();
		expect(harness.autohide.revealed).toBe(true);

		harness.setActive(false);
		expect(harness.autohide.revealed).toBe(false);
		expect(harness.autohide.collapsed).toBe(false);

		harness.autohide.collapse();
		harness.setActive(true);
		expect(harness.autohide.collapsed).toBe(true);
	});

	it('keeps the sidebar revealed while its controls are focused', () => {
		const { autohide } = createState();
		const container = document.createElement('div');
		const button = document.createElement('button');
		container.append(button);
		document.body.append(container);
		button.focus();
		autohide.reveal();

		autohide.collapseUnlessEngaged(container);
		expect(autohide.revealed).toBe(true);

		button.blur();
		autohide.collapseUnlessEngaged(container);
		expect(autohide.collapsed).toBe(true);
	});

	it('keeps the sidebar revealed while a portalled control is open', () => {
		const { autohide } = createState();
		const container = document.createElement('div');
		const trigger = document.createElement('button');
		trigger.setAttribute('aria-expanded', 'true');
		container.append(trigger);
		document.body.append(container);
		autohide.reveal();

		autohide.collapseUnlessEngaged(container);
		expect(autohide.revealed).toBe(true);

		trigger.setAttribute('aria-expanded', 'false');
		autohide.collapseUnlessEngaged(container);
		expect(autohide.collapsed).toBe(true);
	});
});

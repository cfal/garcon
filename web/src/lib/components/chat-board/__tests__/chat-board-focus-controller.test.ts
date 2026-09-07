import { afterEach, describe, expect, it } from 'vitest';
import { ChatBoardFocusController } from '../chat-board-focus-controller';

afterEach(() => {
	document.body.replaceChildren();
});

describe('ChatBoardFocusController', () => {
	it('hands focus from a soon-hidden wide lane to the selected narrow lane heading', () => {
		const root = document.createElement('section');
		root.innerHTML = `
			<section data-chat-board-column-id="a">
				<h2 tabindex="-1" data-chat-board-lane-heading="a">Ready</h2>
			</section>
			<section data-chat-board-column-id="b">
				<h2 tabindex="-1" data-chat-board-lane-heading="b">Review</h2>
				<button type="button">Focused card</button>
			</section>
		`;
		document.body.append(root);
		const controller = new ChatBoardFocusController();
		controller.setRoot(root);
		root.querySelector<HTMLButtonElement>('button')!.focus();

		controller.preparePresentationChange('narrow', 'a');
		root.querySelector('[data-chat-board-column-id="b"]')?.remove();
		controller.completePresentationChange();

		expect(document.activeElement).toBe(root.querySelector('[data-chat-board-lane-heading="a"]'));
	});

	it.each([
		['wide', 'narrow'],
		['narrow', 'medium'],
	] as const)(
		'restores the focused occurrence control across a %s to %s remount',
		(_, nextBand) => {
			const root = document.createElement('section');
			const lane = () => `
			<section data-chat-board-column-id="a">
				<h2 tabindex="-1" data-chat-board-lane-heading="a">Ready</h2>
				<article data-chat-board-occurrence="a:chat-1">
					<button type="button" data-chat-board-focus-target="transition">Transition</button>
				</article>
			</section>
		`;
			root.innerHTML = lane();
			document.body.append(root);
			const controller = new ChatBoardFocusController();
			controller.setRoot(root);
			root.querySelector<HTMLButtonElement>('[data-chat-board-focus-target="transition"]')!.focus();

			controller.preparePresentationChange(nextBand, 'a');
			root.innerHTML = lane();
			controller.completePresentationChange();

			expect(document.activeElement).toBe(
				root.querySelector('[data-chat-board-focus-target="transition"]'),
			);
		},
	);

	it('moves focus from a disappearing narrow tab to its wide lane heading', () => {
		const root = document.createElement('section');
		root.innerHTML = '<button data-chat-board-tab="a">Ready</button>';
		document.body.append(root);
		const controller = new ChatBoardFocusController();
		controller.setRoot(root);
		root.querySelector<HTMLButtonElement>('button')!.focus();

		controller.preparePresentationChange('medium', 'a');
		root.innerHTML = '<h2 tabindex="-1" data-chat-board-lane-heading="a">Ready</h2>';
		controller.completePresentationChange();

		expect(document.activeElement).toBe(root.querySelector('[data-chat-board-lane-heading="a"]'));
	});

	it('does not steal focus owned outside the board', () => {
		const outside = document.createElement('button');
		const root = document.createElement('section');
		root.innerHTML = '<h2 tabindex="-1" data-chat-board-lane-heading="a">Ready</h2>';
		document.body.append(root, outside);
		const controller = new ChatBoardFocusController();
		controller.setRoot(root);
		outside.focus();

		controller.preparePresentationChange('narrow', 'a');
		controller.completePresentationChange();

		expect(document.activeElement).toBe(outside);
	});
});

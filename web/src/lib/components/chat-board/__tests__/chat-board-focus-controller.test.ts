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

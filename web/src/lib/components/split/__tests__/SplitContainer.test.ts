import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SplitContainerChatPaneStub from './SplitContainerChatPaneStub.svelte';
import SplitContainerResizerStub from './SplitContainerResizerStub.svelte';

vi.mock('../ChatPane.svelte', () => ({
	default: SplitContainerChatPaneStub,
}));

vi.mock('../SplitResizer.svelte', () => ({
	default: SplitContainerResizerStub,
}));

import SplitContainer from '../SplitContainer.svelte';
import type { LayoutNode, SplitDirection } from '$lib/stores/split-layout.svelte';

function splitNode(direction: SplitDirection, ratio = 0.5): LayoutNode {
	return {
		type: 'split',
		direction,
		ratio,
		children: [
			{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
			{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
		],
	};
}

function renderSplit(direction: SplitDirection, ratio = 0.5, onMaximizePane = vi.fn()) {
	return render(SplitContainer, {
		node: splitNode(direction, ratio),
		focusedPaneId: 'pane-left',
		previewStore: {} as never,
		onFocusPane: vi.fn(),
		onClosePane: vi.fn(),
		onMaximizePane,
		onSetRatio: vi.fn(),
	});
}

describe('SplitContainer', () => {
	it('uses grid tracks for horizontal pane sizing so fixed resizers cannot overflow', () => {
		const { container } = renderSplit('horizontal');
		const split = container.querySelector<HTMLElement>('[data-split-container]');
		const paneWrappers = container.querySelectorAll<HTMLElement>('[data-split-pane-wrapper]');

		expect(split?.className).toContain('grid');
		expect(split?.className).toContain('gap-px');
		expect(split?.getAttribute('style')).toContain('grid-template-columns');
		expect(split?.getAttribute('style')).toContain('0.5fr');
		expect(split?.getAttribute('style')).toContain('auto');
		expect(split?.getAttribute('style')).not.toContain('calc(');
		for (const wrapper of paneWrappers) {
			expect(wrapper.getAttribute('style') ?? '').toBe('');
		}
	});

	it('uses grid tracks for vertical pane sizing', () => {
		const { container } = renderSplit('vertical', 0.65);
		const split = container.querySelector<HTMLElement>('[data-split-container]');

		expect(split?.getAttribute('style')).toContain('grid-template-rows');
		expect(split?.getAttribute('style')).toContain('0.65fr');
		expect(split?.getAttribute('style')).toContain('0.35fr');
		expect(split?.getAttribute('style')).not.toContain('calc(');
	});

	it('forwards pane maximize actions to the owning layout', () => {
		const onMaximizePane = vi.fn();
		renderSplit('horizontal', 0.5, onMaximizePane);

		document.querySelector<HTMLButtonElement>('[aria-label="Maximize pane-right"]')?.click();

		expect(onMaximizePane).toHaveBeenCalledWith('pane-right');
	});
});

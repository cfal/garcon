import { cleanup, render, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatAgentTags from '../ChatAgentTags.svelte';
import { installResizeObserverHarness, ResizeObserverHarness } from './resize-observer-harness.js';

describe('ChatAgentTags', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('keeps the measured overflow control visible for long tags in a narrow card', async () => {
		const tags = Array.from({ length: 7 }, (_, index) => `long-tag-${index + 1}`);
		const { container } = render(ChatAgentTags, {
			agentId: 'claude',
			tags,
			tagLimit: 6,
			wrap: 'two-lines',
			onManageTags: vi.fn(),
		});
		await Promise.resolve();
		const root = container.querySelector<HTMLElement>('[data-slot="chat-agent-tags"]');
		if (!root) throw new Error('Expected Chat Agent Tags root');
		const agentMeasure = container.querySelector<HTMLElement>(
			'[data-chat-agent-tags-agent-measure]',
		);
		if (!agentMeasure) throw new Error('Expected agent measurement');
		agentMeasure.getBoundingClientRect = () => ({ width: 48 }) as DOMRect;
		for (const element of container.querySelectorAll<HTMLElement>(
			'[data-chat-agent-tags-tag-measure]',
		)) {
			element.getBoundingClientRect = () => ({ width: 116 }) as DOMRect;
		}
		for (const element of container.querySelectorAll<HTMLElement>(
			'[data-chat-agent-tags-overflow-measure]',
		)) {
			element.getBoundingClientRect = () => ({ width: 18 }) as DOMRect;
		}

		ResizeObserverHarness.emit(root, 240);
		await Promise.resolve();

		expect(root.textContent).toContain('long-tag-1');
		expect(root.textContent).toContain('long-tag-2');
		expect(root.textContent).not.toContain('long-tag-3');
		expect(within(root).getByRole('button', { name: '+5' })).toBeTruthy();
	});
});

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

	it('preserves the flowing default layout for narrow sidebar summaries', () => {
		const { container } = render(ChatAgentTags, {
			agentId: 'claude',
			tags: ['frontend-platform', 'production-support', 'urgent'],
			onManageTags: vi.fn(),
		});
		const root = container.querySelector<HTMLElement>('[data-slot="chat-agent-tags"]');
		if (!root) throw new Error('Expected Chat Agent Tags root');

		expect(root.classList.contains('overflow-hidden')).toBe(false);
		expect(root.classList.contains('whitespace-nowrap')).toBe(false);
		expect(within(root).getByRole('button', { name: '+1' })).toBeTruthy();
	});

	it('keeps explicit single-line board tags clipped to their row', () => {
		const { container } = render(ChatAgentTags, {
			agentId: 'claude',
			tags: ['frontend-platform', 'production-support', 'urgent'],
			wrap: 'none',
		});
		const root = container.querySelector<HTMLElement>('[data-slot="chat-agent-tags"]');
		if (!root) throw new Error('Expected Chat Agent Tags root');

		expect(root.classList.contains('overflow-hidden')).toBe(true);
		expect(root.classList.contains('whitespace-nowrap')).toBe(true);
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

	it('retains fractional root width when measurement content resizes', async () => {
		const tags = [
			'customer-experience',
			'release-management',
			'frontend-platform',
			'production-support',
			'quality-assurance',
			'security-review',
			'urgent',
		];
		const { container } = render(ChatAgentTags, {
			agentId: 'claude',
			tags,
			tagLimit: 6,
			wrap: 'two-lines',
			onManageTags: vi.fn(),
		});
		await Promise.resolve();
		const root = container.querySelector<HTMLElement>('[data-slot="chat-agent-tags"]');
		const rail = container.querySelector<HTMLElement>(
			'[data-slot="chat-agent-tags-measurement"]',
		);
		const agentMeasure = container.querySelector<HTMLElement>(
			'[data-chat-agent-tags-agent-measure]',
		);
		if (!root || !rail || !agentMeasure) throw new Error('Expected tag measurement elements');

		Object.defineProperty(root, 'clientWidth', { value: 231 });
		agentMeasure.getBoundingClientRect = () => ({ width: 47.34375 }) as DOMRect;
		const tagWidths = [114.609375, 113.5, 97.890625, 116, 108, 92];
		for (const [index, element] of Array.from(
			container.querySelectorAll<HTMLElement>('[data-chat-agent-tags-tag-measure]'),
		).entries()) {
			element.getBoundingClientRect = () => ({ width: tagWidths[index] ?? 0 }) as DOMRect;
		}
		for (const element of container.querySelectorAll<HTMLElement>(
			'[data-chat-agent-tags-overflow-measure]',
		)) {
			element.getBoundingClientRect = () => ({ width: 11.40625 }) as DOMRect;
		}

		ResizeObserverHarness.emit(root, 230.5);
		await Promise.resolve();
		expect(within(root).getByRole('button', { name: '+5' })).toBeTruthy();

		ResizeObserverHarness.emit(rail, 600);
		await Promise.resolve();
		expect(within(root).getByRole('button', { name: '+5' })).toBeTruthy();
	});
});

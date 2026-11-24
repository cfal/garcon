import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '../../shared/__tests__/resize-observer-harness';
import ModelSelectorPopoverHost from './ModelSelectorPopoverHost.svelte';

it('keeps the full model name or offers the same picker through one Settings menu item', async () => {
	const restore = installResizeObserverHarness();
	try {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'settings' },
			onChange: vi.fn(),
		});
		const trigger = screen.getByRole('button', { name: 'Claude Model 0' });
		const frame = trigger.parentElement!;
		const [combined, model] = frame.querySelectorAll('[inert] > span');
		ResizeObserverHarness.emit(combined, 140.25);
		ResizeObserverHarness.emit(model, 81.5);
		const fit = async (width: number) => {
			ResizeObserverHarness.emit(frame, width);
			await tick();
		};
		await fit(140.25);
		expect(trigger.textContent).toBe('Claude Model 0');
		await fit(140);
		expect(trigger.textContent).toBe('Model 0');
		trigger.focus();
		await fit(81);
		const more = screen.getByRole('button', { name: 'More model settings' });
		expect(document.activeElement).toBe(more);
		expect(screen.queryByRole('button', { name: 'Model 0' })).toBeNull();
		await fireEvent.click(more);
		const items = screen.getAllByRole('menuitem');
		expect(items).toHaveLength(1);
		expect(items[0].textContent).toContain('Claude / Model 0');
		expect(screen.getByRole('menuitem', { description: trigger.title })).toBe(items[0]);
		await fireEvent.click(items[0]);
		expect(await screen.findByRole('listbox', { name: 'Model' })).toBeTruthy();
	} finally {
		cleanup();
		restore();
	}
});

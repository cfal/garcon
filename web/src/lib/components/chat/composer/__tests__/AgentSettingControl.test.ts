import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposerAgentSettings } from '../composer-toolbar-types';
import AgentSettingControl from '../AgentSettingControl.svelte';

describe('AgentSettingControl', () => {
	afterEach(cleanup);

	it('focuses a native number setting and leaves its editing keys to the input', async () => {
		const descriptor = {
			key: 'limit',
			type: 'number',
			label: 'Limit',
			min: 1,
			max: 8,
			step: 1,
		} as const;
		const onChange = vi.fn();
		const defaults = { ownerId: 'sample-agent', schemaVersion: 1, values: { limit: 1 } };
		const settings = { descriptors: [descriptor], defaults, envelope: defaults, onChange };
		const { rerender } = render(AgentSettingControl, {
			descriptor,
			settings,
			placement: 'inline',
			align: 'end',
			side: 'top',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Limit: 1' }));
		const input = screen.getByRole('spinbutton', { name: 'Limit' });
		await waitFor(() => expect(document.activeElement).toBe(input));
		const bubbled: string[] = [];
		const record = (event: KeyboardEvent) => bubbled.push(event.key);
		document.addEventListener('keydown', record);
		try {
			for (const key of ['ArrowUp', '1']) {
				expect(await fireEvent.keyDown(input, { key })).toBe(true);
				expect(document.activeElement).toBe(input);
			}
			expect(bubbled).toEqual([]);
			await fireEvent.keyDown(input, { key: 'Tab' });
			expect(bubbled).toEqual(['Tab']);
		} finally {
			document.removeEventListener('keydown', record);
		}
		await fireEvent.change(input, { target: { value: '4' } });
		expect(onChange).toHaveBeenCalledWith(descriptor, 4);
		await rerender({ settings: { ...settings, disabled: true } });
		expect((input as HTMLInputElement).disabled).toBe(true);
		await fireEvent.change(input, { target: { value: '6' } });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('renders runtime descriptors and reports provider-neutral changes', async () => {
		const onChange = vi.fn();
		const settings = {
			descriptors: [
				{
					key: 'effort',
					type: 'enum',
					label: 'Server Thinking',
					labelKey: 'thinking',
					options: [
						{
							value: 'low',
							label: 'Server Auto',
							labelKey: 'automatic',
							description: 'Server automatic description',
							descriptionKey: 'thinkingAutomatic',
						},
						{
							value: 'high',
							label: 'Server On',
							labelKey: 'enabled',
							description: 'Server enabled description',
							descriptionKey: 'thinkingEnabled',
						},
					],
				},
				{ key: 'review', type: 'boolean', label: 'Review changes' },
			],
			defaults: { ownerId: 'sample-agent', schemaVersion: 1, values: { effort: 'low' } },
			envelope: { ownerId: 'sample-agent', schemaVersion: 1, values: { review: false } },
			onChange,
		} satisfies ComposerAgentSettings;
		for (const descriptor of settings.descriptors) {
			render(AgentSettingControl, {
				descriptor,
				settings,
				placement: 'inline',
				align: 'end',
				side: 'top',
			});
		}

		const effortTrigger = screen.getByRole('button', { name: 'Thinking: Auto' });
		expect(effortTrigger.className).toContain('bg-composer-agent-setting');
		expect(effortTrigger.querySelector('[data-slot="agent-thinking-icon"]')).toBeTruthy();
		expect(screen.queryByRole('combobox', { name: 'Thinking' })).toBeNull();

		await fireEvent.click(effortTrigger);
		expect(screen.getByText('Lets Claude decide when extended thinking is useful.')).toBeTruthy();
		expect(screen.getByText('Uses extended thinking for every response.')).toBeTruthy();
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: /^On/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Review changes: Off' }));
		await fireEvent.click(screen.getByRole('menuitemradio', { name: 'On' }));

		expect(onChange).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ key: 'effort', type: 'enum' }),
			'high',
		);
		expect(onChange).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ key: 'review', type: 'boolean' }),
			true,
		);
	});
});

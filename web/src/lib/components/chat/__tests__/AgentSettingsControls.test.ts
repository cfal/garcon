import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentSettingsControls from '../AgentSettingsControls.svelte';

describe('AgentSettingsControls', () => {
	afterEach(cleanup);

	it('renders runtime descriptors and reports provider-neutral changes', async () => {
		const onChange = vi.fn();
		render(AgentSettingsControls, {
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
			envelope: {
				ownerId: 'sample-agent',
				schemaVersion: 1,
				values: { effort: 'low', review: false },
			},
			onChange,
		});

		const effortTrigger = screen.getByRole('button', { name: 'Thinking: Auto' });
		expect(effortTrigger.className).toContain('bg-composer-agent-setting');
		expect(effortTrigger.querySelector('[data-slot="agent-thinking-icon"]')).toBeTruthy();
		expect(screen.queryByRole('combobox', { name: 'Thinking' })).toBeNull();

		await fireEvent.click(effortTrigger);
		expect(screen.getByText('Lets Claude decide when extended thinking is useful.')).toBeTruthy();
		expect(screen.getByText('Uses extended thinking for every response.')).toBeTruthy();
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: /^On/ }));
		await fireEvent.click(screen.getByLabelText('Review changes'));

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

	it('renders Codex Fast mode through the generic enum control', async () => {
		const onChange = vi.fn();
		const descriptor = {
			key: 'codexFastMode',
			type: 'enum' as const,
			label: 'Server Fast',
			labelKey: 'fastMode' as const,
			options: [
				{
					value: 'on',
					label: 'Server On',
					labelKey: 'enabled' as const,
					description: 'Server enabled description',
					descriptionKey: 'fastModeEnabled' as const,
				},
				{
					value: 'off',
					label: 'Server Off',
					labelKey: 'disabled' as const,
					description: 'Server disabled description',
					descriptionKey: 'fastModeDisabled' as const,
				},
			],
		};
		render(AgentSettingsControls, {
			descriptors: [descriptor],
			envelope: {
				ownerId: 'codex',
				schemaVersion: 2,
				values: { codexFastMode: 'off' },
			},
			onChange,
		});

		const trigger = screen.getByRole('button', { name: 'Fast mode: Off' });
		expect(trigger.title).toBe('Fast mode: Off');
		expect(trigger.querySelector('[data-slot="agent-fast-mode-icon"]')).toBeTruthy();
		await fireEvent.click(trigger);
		expect(screen.getByText(/Uses priority processing/)).toBeTruthy();
		expect(screen.getByText(/overrides any global Codex Fast setting/)).toBeTruthy();
		expect(screen.getByRole('menuitemradio', { name: /^Off/ }).getAttribute('data-state'))
			.toBe('checked');
		await fireEvent.click(screen.getByRole('menuitemradio', { name: /^On/ }));

		expect(onChange).toHaveBeenCalledWith(descriptor, 'on');
	});
});

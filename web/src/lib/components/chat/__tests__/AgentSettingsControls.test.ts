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
});

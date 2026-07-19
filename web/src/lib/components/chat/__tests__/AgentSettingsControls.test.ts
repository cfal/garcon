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
					label: 'Effort',
					options: [
						{ value: 'low', label: 'Low' },
						{ value: 'high', label: 'High' },
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

		await fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } });
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

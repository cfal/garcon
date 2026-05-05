import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import VirtualModelList from '../VirtualModelList.svelte';
import type { ModelSelectorRow } from '../model-selector-types';

function makeRows(count: number): ModelSelectorRow[] {
	return Array.from({ length: count }, (_, index) => ({
		value: `model-${index}`,
		label: `Model ${index}`,
		searchText: `model ${index} provider/model-${index}`,
		model: {
			value: `model-${index}`,
			label: `Model ${index}`,
			rawModel: `provider/model-${index}`,
		},
	}));
}

describe('VirtualModelList', () => {
	it('renders a bounded visible slice', () => {
		render(VirtualModelList, {
			props: {
				rows: makeRows(600),
				selectedValue: 'model-0',
				activeIndex: 0,
				listId: 'models',
				ariaLabel: 'Models',
				onActiveIndexChange: vi.fn(),
				onSelect: vi.fn(),
			},
		});

		expect(screen.getByText('Model 0')).toBeTruthy();
		expect(screen.queryByText('Model 599')).toBeNull();
		expect(screen.getAllByRole('option').length).toBeLessThan(40);
	});

	it('selects visible rows by click', async () => {
		const onSelect = vi.fn();
		render(VirtualModelList, {
			props: {
				rows: makeRows(50),
				selectedValue: 'model-0',
				activeIndex: 0,
				listId: 'models',
				ariaLabel: 'Models',
				onActiveIndexChange: vi.fn(),
				onSelect,
			},
		});

		await fireEvent.click(screen.getByText('Model 3'));

		expect(onSelect).toHaveBeenCalledWith('model-3');
	});
});

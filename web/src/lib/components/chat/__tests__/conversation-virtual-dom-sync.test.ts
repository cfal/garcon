import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ConversationVirtualDomSyncTestHost from './ConversationVirtualDomSyncTestHost.svelte';

interface Exposure {
	resizeFirstRow(size: number): void;
}

describe('Conversation virtual DOM synchronization', () => {
	afterEach(() => cleanup());

	it('commits compensated measurements before resizeItem returns', async () => {
		let exposure: Exposure | null = null;
		render(ConversationVirtualDomSyncTestHost, {
			onReady(value) {
				exposure = value;
			},
		});

		await waitFor(() => {
			expect(exposure).not.toBeNull();
			expect(screen.getByTestId('sizer').style.height).toBe('120px');
			expect(screen.getByTestId('row-1').style.transform).toBe('translateY(40px)');
		});

		exposure!.resizeFirstRow(60);

		expect(screen.getByTestId('sizer').style.height).toBe('140px');
		expect(screen.getByTestId('row-1').style.transform).toBe('translateY(60px)');
	});
});

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitPlanModeToolUseMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';
import ExitPlanOccurrenceTestHost from './ExitPlanOccurrenceTestHost.svelte';

const timestamp = '2026-08-15T00:00:00.000Z';

function pendingExitPlan(permissionOccurrenceId: string): PendingPermissionRequest {
	return {
		permissionOccurrenceId,
		requestedTool: new ExitPlanModeToolUseMessage(timestamp, 'plan-1', 'Current plan.'),
		chatId: 'chat-1',
		receivedAt: new Date(timestamp),
		planReference: { chatId: 'chat-1', serverInstanceId: 'instance-1', transcriptViewId: 'view-1', ordinal: permissionOccurrenceId === 'plan:view-1:1' ? 1 : 2 },
	};
}

describe('exit-plan permission occurrence rendering', () => {
	afterEach(cleanup);

	it('does not make an older exit-plan row actionable for a different occurrence', () => {
		render(ExitPlanOccurrenceTestHost, {
			pendingPermissionRequests: [pendingExitPlan('current-occurrence')],
			onExitPlanMode: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: 'Yes, approve edits' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
		expect(screen.queryByText('Plan approved')).toBeNull();
		expect(screen.queryByText('Plan cancelled')).toBeNull();
		expect(screen.getByText('Plan', { selector: 'span' })).toBeTruthy();
	});

	it('keeps approval and dismissal on the exact inline presentation occurrence', async () => {
		const onExitPlanMode = vi.fn();
		render(ExitPlanOccurrenceTestHost, {
			pendingPermissionRequests: [pendingExitPlan('plan:view-1:1')],
			onExitPlanMode,
		});

		expect(screen.getByRole('button', { name: 'Yes, approve edits' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Revise plan' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		expect(onExitPlanMode).toHaveBeenCalledWith('plan:view-1:1', 'dismiss', '');
	});
});

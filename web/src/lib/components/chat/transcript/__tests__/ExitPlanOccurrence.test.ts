import { cleanup, render, screen } from '@testing-library/svelte';
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
	});

	it('keeps the exact synthetic exit-plan occurrence actionable', () => {
		render(ExitPlanOccurrenceTestHost, {
			pendingPermissionRequests: [pendingExitPlan('plan-exit-plan-1')],
			onExitPlanMode: vi.fn(),
		});

		expect(screen.getByRole('button', { name: 'Yes, approve edits' })).toBeTruthy();
	});
});

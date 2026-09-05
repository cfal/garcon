import { describe, expect, it } from 'vitest';
import { WORKSPACE_WINDOW_RESOURCE_CEILING } from '../surface-types';
import {
	requireWorkspaceSplitAdmission,
	requireWorkspaceNewWindowEdge,
	WorkspaceSplitBlockedError,
	workspaceSplitBlockMessage,
} from '../workspace-split-blocked-error';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';

describe('workspace split blocked errors', () => {
	it.each([
		['too-small', 'Not enough space to split this window.'],
		['resource-ceiling', `Window limit reached (maximum ${WORKSPACE_WINDOW_RESOURCE_CEILING})`],
		['fullscreen', 'Exit fullscreen to open a new window.'],
	] as const)('localizes %s', (reason, expected) => {
		expect(workspaceSplitBlockMessage(reason)).toBe(expected);
		expect(new WorkspaceSplitBlockedError(reason)).toMatchObject({
			name: 'WorkspaceSplitBlockedError',
			message: expected,
			reason,
		});
	});

	it('returns false without constructing an error for an inapplicable request', () => {
		expect(
			requireWorkspaceSplitAdmission(() => null, canonicalWorkspaceSnapshot(), {
				targetWindowId: 'window-main',
				edge: 'right',
			}),
		).toBe(false);
	});

	it('throws only user-facing denial reasons', () => {
		expect(() =>
			requireWorkspaceSplitAdmission(
				() => ({ allowed: false, reason: 'too-small' }),
				canonicalWorkspaceSnapshot(),
				{ targetWindowId: 'window-main', edge: 'right' },
			),
		).toThrow(WorkspaceSplitBlockedError);
		expect(
			requireWorkspaceSplitAdmission(() => ({ allowed: true }), canonicalWorkspaceSnapshot(), {
				targetWindowId: 'window-main',
				edge: 'right',
			}),
		).toBe(true);
	});
});

describe('automatic new-window direction', () => {
	it('prefers right when both axes fit', () => {
		expect(
			requireWorkspaceNewWindowEdge(
				() => ({ allowed: true }),
				canonicalWorkspaceSnapshot(),
				'window-main',
			),
		).toBe('right');
	});
	it('uses bottom when right is too narrow', () => {
		expect(
			requireWorkspaceNewWindowEdge(
				(_snapshot, { edge }) =>
					edge === 'bottom' ? { allowed: true } : { allowed: false, reason: 'too-small' },
				canonicalWorkspaceSnapshot(),
				'window-main',
			),
		).toBe('bottom');
	});
	it.each(['too-small', 'resource-ceiling', 'fullscreen'] as const)(
		'preserves %s denial when neither axis fits',
		(reason) => {
			expect(() =>
				requireWorkspaceNewWindowEdge(
					() => ({ allowed: false, reason }),
					canonicalWorkspaceSnapshot(),
					'window-main',
				),
			).toThrow(new WorkspaceSplitBlockedError(reason));
		},
	);
	it('does not invent a placement for a stale anchor', () => {
		expect(
			requireWorkspaceNewWindowEdge(() => null, canonicalWorkspaceSnapshot(), 'window-missing'),
		).toBeNull();
	});
});

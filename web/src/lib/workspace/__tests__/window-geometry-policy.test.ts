import { describe, expect, it } from 'vitest';
import type {
	DesktopWorkspaceNode,
	SurfaceDescriptor,
	WorkspaceLayoutSnapshot,
	WorkspacePartitionNode,
	WorkspaceWindowId,
	WorkspaceWindowNode,
} from '../surface-types';
import { WORKSPACE_WINDOW_RESOURCE_CEILING } from '../surface-types';
import {
	COMPACT_ENTER_WINDOW_HEIGHT_PX,
	COMPACT_ENTER_WINDOW_WIDTH_PX,
	clampWorkspacePartitionRatio,
	resolveWorkspaceCompactActive,
	resolveWorkspacePartitionRatioBounds,
	resolveWorkspaceSplitAdmission,
} from '../window-geometry-policy';

function workspaceWindow(id: WorkspaceWindowId, surfaceIds: readonly string[] = [`chat:${id}`]) {
	return {
		type: 'window',
		id,
		tabs: { order: surfaceIds, activeId: surfaceIds[0]!, mru: surfaceIds },
	} satisfies WorkspaceWindowNode;
}

function partition(
	id: string,
	direction: 'horizontal' | 'vertical',
	ratio: number,
	first: DesktopWorkspaceNode,
	second: DesktopWorkspaceNode,
): WorkspacePartitionNode {
	return {
		type: 'partition',
		id: `partition-${id}`,
		direction,
		ratio,
		children: [first, second],
	};
}

function snapshot(root: DesktopWorkspaceNode): WorkspaceLayoutSnapshot {
	const surfaces: Record<string, SurfaceDescriptor> = {};
	const visit = (node: DesktopWorkspaceNode): void => {
		if (node.type === 'partition') {
			visit(node.children[0]);
			visit(node.children[1]);
			return;
		}
		for (const surfaceId of node.tabs.order) {
			surfaces[surfaceId] = { id: surfaceId, type: 'file', fileSessionId: surfaceId };
		}
	};
	visit(root);
	const firstSurfaceId = Object.keys(surfaces)[0]!;
	return {
		desktopRoot: root,
		surfaces,
		fullscreenWindowId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: firstSurfaceId,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

describe('workspace split admission', () => {
	it.each([
		['left', 719, 600, false],
		['left', 720, 240, true],
		['right', 720, 239, false],
		['top', 360, 479, false],
		['bottom', 360, 480, true],
	] as const)('resolves %s at %d x %d', (edge, width, height, allowed) => {
		const result = resolveWorkspaceSplitAdmission({
			snapshot: snapshot(workspaceWindow('window-main')),
			hostSize: { width, height },
			singleWindowProjectionActive: false,
			targetWindowId: 'window-main',
			edge,
		});

		expect(result?.allowed).toBe(allowed);
	});

	it('floors target pixels before splitting them', () => {
		const result = resolveWorkspaceSplitAdmission({
			snapshot: snapshot(
				partition(
					'root',
					'horizontal',
					0.5001,
					workspaceWindow('window-target'),
					workspaceWindow('window-other'),
				),
			),
			hostSize: { width: 1439, height: 600 },
			singleWindowProjectionActive: false,
			targetWindowId: 'window-target',
			edge: 'right',
		});

		expect(result).toEqual({ allowed: false, reason: 'too-small' });
	});

	it('fails open without a measurement but retains the resource ceiling', () => {
		const one = snapshot(workspaceWindow('window-main'));
		expect(
			resolveWorkspaceSplitAdmission({
				snapshot: one,
				hostSize: null,
				singleWindowProjectionActive: false,
				targetWindowId: 'window-main',
				edge: 'right',
			}),
		).toEqual({ allowed: true });

		let root: DesktopWorkspaceNode = workspaceWindow('window-1');
		for (let index = 2; index <= WORKSPACE_WINDOW_RESOURCE_CEILING; index += 1) {
			root = partition(String(index), 'horizontal', 0.5, root, workspaceWindow(`window-${index}`));
		}
		expect(
			resolveWorkspaceSplitAdmission({
				snapshot: snapshot(root),
				hostSize: null,
				singleWindowProjectionActive: false,
				targetWindowId: 'window-1',
				edge: 'right',
			}),
		).toEqual({ allowed: false, reason: 'resource-ceiling' });
	});

	it('blocks fullscreen and an active single-window projection', () => {
		const ordinary = snapshot(workspaceWindow('window-main'));
		expect(
			resolveWorkspaceSplitAdmission({
				snapshot: { ...ordinary, fullscreenWindowId: 'window-main' },
				hostSize: { width: 2000, height: 1200 },
				singleWindowProjectionActive: false,
				targetWindowId: 'window-main',
				edge: 'right',
			}),
		).toEqual({ allowed: false, reason: 'fullscreen' });
		expect(
			resolveWorkspaceSplitAdmission({
				snapshot: ordinary,
				hostSize: { width: 2000, height: 1200 },
				singleWindowProjectionActive: true,
				targetWindowId: 'window-main',
				edge: 'right',
			}),
		).toEqual({ allowed: false, reason: 'too-small' });
	});

	it('checks only the target and accounts for sole-tab source collapse', () => {
		const root = partition(
			'root',
			'horizontal',
			0.4,
			workspaceWindow('window-source', ['moving']),
			workspaceWindow('window-target'),
		);
		const input = {
			snapshot: snapshot(root),
			hostSize: { width: 960, height: 600 },
			singleWindowProjectionActive: false,
			targetWindowId: 'window-target' as const,
			edge: 'right' as const,
		};

		expect(resolveWorkspaceSplitAdmission(input)).toEqual({
			allowed: false,
			reason: 'too-small',
		});
		expect(resolveWorkspaceSplitAdmission({ ...input, movingSurfaceId: 'moving' })).toEqual({
			allowed: true,
		});

		const largeTarget = partition(
			'large-target',
			'horizontal',
			0.25,
			workspaceWindow('window-small'),
			workspaceWindow('window-large'),
		);
		expect(
			resolveWorkspaceSplitAdmission({
				snapshot: snapshot(largeTarget),
				hostSize: { width: 1200, height: 600 },
				singleWindowProjectionActive: false,
				targetWindowId: 'window-large',
				edge: 'right',
			}),
		).toEqual({ allowed: true });
	});

	it('returns null for stale requests and same-target sole-tab moves', () => {
		const current = snapshot(workspaceWindow('window-main', ['only']));
		const base = {
			snapshot: current,
			hostSize: { width: 1200, height: 800 },
			singleWindowProjectionActive: false,
			edge: 'right' as const,
		};
		expect(resolveWorkspaceSplitAdmission({ ...base, targetWindowId: 'window-stale' })).toBeNull();
		expect(
			resolveWorkspaceSplitAdmission({
				...base,
				targetWindowId: 'window-main',
				movingSurfaceId: 'missing',
			}),
		).toBeNull();
		expect(
			resolveWorkspaceSplitAdmission({
				...base,
				targetWindowId: 'window-main',
				movingSurfaceId: 'only',
			}),
		).toBeNull();
	});
});

describe('workspace compact policy', () => {
	const horizontal = partition(
		'root',
		'horizontal',
		0.5,
		workspaceWindow('window-left'),
		workspaceWindow('window-right'),
	);

	it('enters on either critical dimension and never folds a sole window', () => {
		expect(
			resolveWorkspaceCompactActive({
				wasActive: false,
				root: horizontal,
				hostSize: { width: COMPACT_ENTER_WINDOW_WIDTH_PX * 2 - 1, height: 800 },
			}),
		).toBe(true);
		const vertical = partition(
			'vertical',
			'vertical',
			0.5,
			workspaceWindow('window-top'),
			workspaceWindow('window-bottom'),
		);
		expect(
			resolveWorkspaceCompactActive({
				wasActive: false,
				root: vertical,
				hostSize: { width: 800, height: COMPACT_ENTER_WINDOW_HEIGHT_PX * 2 - 1 },
			}),
		).toBe(true);
		expect(
			resolveWorkspaceCompactActive({
				wasActive: false,
				root: workspaceWindow('window-only'),
				hostSize: { width: 1, height: 1 },
			}),
		).toBe(false);
	});

	it('holds through the hysteresis band and exits only when every leaf is safe', () => {
		expect(
			resolveWorkspaceCompactActive({
				wasActive: false,
				root: horizontal,
				hostSize: { width: 500, height: 800 },
			}),
		).toBe(false);
		expect(
			resolveWorkspaceCompactActive({
				wasActive: true,
				root: horizontal,
				hostSize: { width: 500, height: 800 },
			}),
		).toBe(true);
		expect(
			resolveWorkspaceCompactActive({
				wasActive: true,
				root: horizontal,
				hostSize: { width: 600, height: 400 },
			}),
		).toBe(false);
	});
});

describe('workspace partition ratio bounds', () => {
	it('derives horizontal and vertical bounds from the compact floor', () => {
		const horizontal = partition(
			'h',
			'horizontal',
			0.5,
			workspaceWindow('window-a'),
			workspaceWindow('window-b'),
		);
		expect(
			resolveWorkspacePartitionRatioBounds({ partition: horizontal, partitionAxisPixels: 1000 }),
		).toEqual({ min: 0.241, max: 0.759, adjustable: true });

		const vertical = { ...horizontal, direction: 'vertical' as const };
		expect(
			resolveWorkspacePartitionRatioBounds({ partition: vertical, partitionAxisPixels: 500 }),
		).toEqual({ min: 0.322, max: 0.6779999999999999, adjustable: true });
	});

	it('accounts for same-axis descendants but not orthogonal partition ratios', () => {
		const nestedHorizontal = partition(
			'root-h',
			'horizontal',
			0.5,
			partition(
				'child-h',
				'horizontal',
				0.5,
				workspaceWindow('window-a'),
				workspaceWindow('window-b'),
			),
			workspaceWindow('window-c'),
		);
		const sameAxis = resolveWorkspacePartitionRatioBounds({
			partition: nestedHorizontal,
			partitionAxisPixels: 1200,
		});
		expect(sameAxis.min).toBeCloseTo(241 / 600);

		const nestedVertical = {
			...nestedHorizontal,
			children: [
				partition(
					'child-v',
					'vertical',
					0.2,
					workspaceWindow('window-a'),
					workspaceWindow('window-b'),
				),
				workspaceWindow('window-c'),
			] as const,
		};
		const orthogonal = resolveWorkspacePartitionRatioBounds({
			partition: nestedVertical,
			partitionAxisPixels: 1200,
		});
		expect(orthogonal.min).toBeCloseTo(241 / 1200);
	});

	it('retains the committed ratio when no legal interval remains', () => {
		const root = partition(
			'root',
			'horizontal',
			0.6,
			workspaceWindow('window-a'),
			workspaceWindow('window-b'),
		);
		expect(
			resolveWorkspacePartitionRatioBounds({ partition: root, partitionAxisPixels: 400 }),
		).toEqual({ min: 0.6, max: 0.6, adjustable: false });
	});

	it('uses broad bounds without geometry and clamps every input consistently', () => {
		const root = partition(
			'root',
			'horizontal',
			0.5,
			workspaceWindow('window-a'),
			workspaceWindow('window-b'),
		);
		const bounds = resolveWorkspacePartitionRatioBounds({
			partition: root,
			partitionAxisPixels: null,
		});
		expect(bounds).toEqual({ min: 0.15, max: 0.85, adjustable: true });
		expect(clampWorkspacePartitionRatio(-1, bounds)).toBe(0.15);
		expect(clampWorkspacePartitionRatio(2, bounds)).toBe(0.85);
		expect(clampWorkspacePartitionRatio(Number.NaN, bounds)).toBe(0.5);
	});

	it('leaves a one-pixel safety margin at a nested boundary', () => {
		const root = partition(
			'root',
			'horizontal',
			0.5,
			partition(
				'child',
				'horizontal',
				0.5,
				workspaceWindow('window-a'),
				workspaceWindow('window-b'),
			),
			workspaceWindow('window-c'),
		);
		const bounds = resolveWorkspacePartitionRatioBounds({
			partition: root,
			partitionAxisPixels: 1200,
		});
		expect(Math.floor(bounds.min * 1200 * 0.5)).toBeGreaterThanOrEqual(
			COMPACT_ENTER_WINDOW_WIDTH_PX,
		);
	});
});

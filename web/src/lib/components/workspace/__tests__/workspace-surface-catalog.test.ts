import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANONICAL_WINDOW_ID, canonicalWorkspaceSnapshot } from '$lib/workspace/canonical-layout';
import { WorkspaceLayoutStore, reduceWorkspaceLayout } from '$lib/workspace/workspace-layout.svelte';
import WorkspaceSurfaceCatalogTestHost from './WorkspaceSurfaceCatalogTestHost.svelte';

const state = vi.hoisted(() => ({
	layout: null as WorkspaceLayoutStore | null,
}));

vi.mock('$lib/context', () => ({
	getChatSessions: () => ({ byId: {}, selectedChat: null }),
	getFileSessions: () => ({ get: () => undefined }),
	getModelCatalog: () => ({ forExecutor: () => ({ supportsUpdateProjectPath: () => false }) }),
	getTerminalRegistry: () => ({ sessions: {}, displayName: () => 'Terminal' }),
	getWorkspaceCoordinator: () => ({ layout: state.layout }),
}));

afterEach(() => {
	cleanup();
	state.layout = null;
});

describe('workspace surface catalog workflow labels', () => {
	it('names workflow-run tabs from workflow navigation and falls back cleanly without it', () => {
		const initial = canonicalWorkspaceSnapshot();
		state.layout = new WorkspaceLayoutStore(
			reduceWorkspaceLayout(initial, [
				{
					type: 'register-surface',
					surface: { id: 'workflow-run', type: 'workflow-run', runId: 'run-42' },
					windowId: CANONICAL_WINDOW_ID,
				},
			]),
		);

		let namedCatalog!: { label(surfaceId: string): string };
		render(WorkspaceSurfaceCatalogTestHost, {
			props: {
				workflowNavigation: {
					openRun: vi.fn(),
					openRunById: vi.fn(),
					openNewWorkflow: vi.fn(),
					openChat: vi.fn(),
					runForChat: () => undefined,
					runName: (id) => (id === 'run-42' ? 'Release gate #42' : undefined),
					rememberRunName: vi.fn(),
				},
				onCatalog: (catalog) => (namedCatalog = catalog),
			},
		});
		expect(namedCatalog.label('workflow-run')).toBe('Release gate #42');

		let fallbackCatalog!: { label(surfaceId: string): string };
		render(WorkspaceSurfaceCatalogTestHost, {
			props: {
				workflowNavigation: null,
				onCatalog: (catalog) => (fallbackCatalog = catalog),
			},
		});
		expect(fallbackCatalog.label('workflow-run')).toBe('Workflow Run');
	});
});

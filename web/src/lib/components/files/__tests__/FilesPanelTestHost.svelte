<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		setFileSessions,
		setNotifications,
		setProjectResolution,
		setSingletonSurfaces,
		setWorkspaceCoordinator,
		setExecutors,
	} from '$lib/context';
	import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
	import FilesPanel from '../FilesPanel.svelte';
	import { getFilesPanelTestContext } from './files-panel-test-context.js';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
	import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';

	let {
		presentation = 'window-main',
		focusFileSession = async () => {},
		projectState = { kind: 'absent' },
	}: {
		presentation?: WorkspaceWindowId | 'mobile';
		projectState?: WorkspaceProjectState;
	} & Partial<Pick<WorkspaceCoordinator, 'focusFileSession'>> = $props();

	const {
		fileSessions,
		singletonSurfaces,
		notifications = new NotificationsStore(),
		executors = new ExecutorsStore(),
	} = getFilesPanelTestContext();
	setFileSessions(fileSessions);
	setSingletonSurfaces(singletonSurfaces);
	setNotifications(notifications);
	setExecutors(executors);
	const projectResolution = new ProjectResolutionStore(async () => {
		throw new Error('No project resolver configured');
	});
	setProjectResolution(projectResolution);
	onDestroy(() => projectResolution.destroy());
	const workspace: Pick<WorkspaceCoordinator, 'focusOwner' | 'focusFileSession'> & {
		layout: Pick<WorkspaceCoordinator['layout'], 'surface'>;
	} = {
		focusOwner: { kind: 'chat-list' },
		layout: { surface: () => null },
		focusFileSession: (sessionId: string) => focusFileSession(sessionId),
	};
	setWorkspaceCoordinator(workspace as WorkspaceCoordinator);
</script>

<FilesPanel {presentation} {projectState} target={null} />

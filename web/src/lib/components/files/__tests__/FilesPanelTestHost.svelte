<script lang="ts">
	import { setFileSessions, setSingletonSurfaces } from '$lib/context';
	import FilesPanel from '../FilesPanel.svelte';
	import { getFilesPanelTestContext } from './files-panel-test-context.js';
	import type { HostId } from '$lib/workspace/surface-types.js';

	let { presentation = 'main' }: { presentation?: HostId | 'mobile' } = $props();

	const { fileSessions, singletonSurfaces } = getFilesPanelTestContext();
	setFileSessions(fileSessions);
	setSingletonSurfaces(singletonSurfaces);
</script>

<FilesPanel {presentation} />

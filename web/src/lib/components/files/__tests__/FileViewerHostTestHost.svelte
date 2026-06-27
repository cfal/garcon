<script lang="ts">
	import FileViewerHost from '../FileViewerHost.svelte';
	import { setFileViewer } from '$lib/context';
	import type { FileViewerStore } from '$lib/stores/file-viewer.svelte';

	interface Props {
		viewer: FileViewerStore;
	}

	let { viewer }: Props = $props();

	function currentViewer(): FileViewerStore {
		return viewer;
	}

	setFileViewer({
		get pending() {
			return currentViewer().pending;
		},
		consumePending: () => currentViewer().consumePending(),
	} as never);
</script>

<FileViewerHost />

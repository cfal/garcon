<script lang="ts">
	import { onMount } from 'svelte';
	import type { FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';
	import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import FileTreeVirtualRows from '../FileTreeVirtualRows.svelte';

	interface BenchmarkWindow extends Window {
		__fileTreeVirtualizationBenchmark?: {
			logicalRowCount: number;
			fixtureConstructionMs: number;
			setFilter(value: string): void;
		};
	}

	const LOGICAL_ROW_COUNT = 500_000;
	const fixtureStartedAt = performance.now();
	const entries: FileTreeEntry[] = Array.from({ length: LOGICAL_ROW_COUNT }, (_, index) => {
		const name = `file-${String(index).padStart(6, '0')}.ts`;
		return {
			name,
			path: `/workspace/${name}`,
			relativePath: name,
			type: 'file',
			size: index,
			modified: null,
			permissionsRwx: 'rw-r--r--',
		};
	});
	const response: FileTreeResponse = {
		fileRootPath: '/workspace',
		directory: {
			path: '/workspace',
			relativePath: '',
			parentPath: null,
			breadcrumbs: [{ name: 'workspace', path: '/workspace' }],
		},
		entries,
	};
	const store = new FileTreeStore();
	store.navigation = { kind: 'ready', response };
	const fixtureConstructionMs = performance.now() - fixtureStartedAt;

	onMount(() => {
		const benchmarkWindow = window as BenchmarkWindow;
		benchmarkWindow.__fileTreeVirtualizationBenchmark = {
			logicalRowCount: LOGICAL_ROW_COUNT,
			fixtureConstructionMs,
			setFilter(value: string): void {
				store.filterInput = value;
			},
		};
		return () => {
			delete benchmarkWindow.__fileTreeVirtualizationBenchmark;
		};
	});
</script>

<div class="flex h-[900px] w-[1200px] flex-col bg-card" data-file-tree-benchmark-host>
	<FileTreeVirtualRows {store} onFileSelect={() => {}} />
</div>

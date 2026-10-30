<script lang="ts">
	let { scrollToRequest }: { scrollToRequest: { filePath: string; token: number } | null } =
		$props();
</script>

<div data-testid="pr-diff-surface-stub" data-scroll-file={scrollToRequest?.filePath ?? ''}></div>

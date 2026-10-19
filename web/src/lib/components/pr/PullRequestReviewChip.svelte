<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import { reviewChipClass, type ReviewChip } from './pr-display';

	let { chip, class: className }: { chip: ReviewChip; class?: string } = $props();
</script>

<span
	class={cn(
		'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[11px] leading-4 font-medium',
		reviewChipClass(chip.tone),
		className,
	)}
	data-pr-review-chip={chip.tone}>{chip.label}</span
>

<script lang="ts">
	import { cn } from '$lib/utils/cn';

	interface ColoredTagProps {
		label: string;
		variant?: string;
		class?: string;
	}

	let { label, variant = '', class: className }: ColoredTagProps = $props();
</script>

<span
	class={cn(
		'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none',
		variant,
		className,
	)}
>
	{label}
</span>

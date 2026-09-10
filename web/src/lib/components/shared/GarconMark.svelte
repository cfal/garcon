<script lang="ts">
	let { class: className = '' }: { class?: string } = $props();
</script>

<svg class={className} aria-hidden="true" viewBox="0 0 256 256">
	<rect class="mark-surface" width="256" height="256" rx="52" />
	<path
		d="M56 58h144a17 17 0 0 1 17 17v91a17 17 0 0 1-17 17h-60l-37 29 8-29H56a17 17 0 0 1-17-17V75a17 17 0 0 1 17-17Z"
		fill="none"
		stroke="currentColor"
		stroke-width="14"
		stroke-linejoin="round"
	/>
	<path
		d="M128 145v-29M128 116 91 91M128 116l37-25"
		fill="none"
		stroke="currentColor"
		stroke-width="12"
		stroke-linecap="round"
	/>
	<circle cx="91" cy="91" r="12" fill="currentColor" />
	<circle cx="165" cy="91" r="12" fill="currentColor" />
	<circle cx="128" cy="148" r="12" fill="currentColor" />
</svg>

<style>
	svg {
		color: hsl(var(--brand-mark-foreground));
	}

	.mark-surface {
		fill: hsl(var(--brand-mark-surface));
	}
</style>

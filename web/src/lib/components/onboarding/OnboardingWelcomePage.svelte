<script lang="ts">
	import LaptopIcon from '@lucide/svelte/icons/laptop';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import * as m from '$lib/paraglide/messages.js';
</script>

<div class="space-y-4 text-sm leading-relaxed">
	<div class="flex items-center gap-4 text-muted-foreground" aria-hidden="true">
		<LaptopIcon class="size-6" />
		<span class="h-px w-8 bg-border"></span>
		<CloudIcon class="size-6" />
		<span class="h-px w-8 bg-border"></span>
		<MonitorIcon class="size-6" />
	</div>
	<p>{m.onboarding_welcome_executors()}</p>
	<p class="text-muted-foreground">{m.onboarding_welcome_search()}</p>
</div>

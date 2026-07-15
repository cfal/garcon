<script lang="ts">
	import Settings from '@lucide/svelte/icons/settings';
	import { getLocalSettings } from '$lib/context';
	import { FONT_SIZE_OPTIONS, isFontSizeOption } from '$lib/utils/font-size.js';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import * as Select from '$lib/components/ui/select';
	import * as m from '$lib/paraglide/messages.js';

	const localSettings = getLocalSettings();
	let menuOpen = $state(false);

	function setFontSize(size: string): void {
		if (!isFontSizeOption(size)) return;
		localSettings.set('terminalFontSize', size);
	}
</script>

<Popover.Root bind:open={menuOpen}>
	<Popover.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		aria-label={m.terminal_settings()}
		title={m.terminal_settings()}
	>
		<Settings class="h-4 w-4" />
	</Popover.Trigger>

	<Popover.Content class="w-72 p-0" align="end" sideOffset={8}>
		<div class="rounded-md border border-border bg-card text-foreground">
			<div class="flex items-center justify-between px-4 py-3">
				<div class="text-sm font-medium text-foreground">{m.terminal_font_size()}</div>
				<Select.Root
					type="single"
					value={localSettings.terminalFontSize}
					onValueChange={(value) => {
						if (value) setFontSize(value);
					}}
				>
					<Select.Trigger class="w-[80px]" size="sm" aria-label={m.terminal_font_size()}>
						{localSettings.terminalFontSize}px
					</Select.Trigger>
					<Select.Content>
						{#each FONT_SIZE_OPTIONS as size (size)}
							<Select.Item value={size} label="{size}px">{size}px</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		</div>
	</Popover.Content>
</Popover.Root>

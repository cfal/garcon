<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import Settings from '@lucide/svelte/icons/settings';
	import { getLocalSettings } from '$lib/context';
	import { FONT_SIZE_OPTIONS } from '$lib/settings/font-size.js';
	import * as m from '$lib/paraglide/messages.js';

	const localSettings = getLocalSettings();

	let menuOpen = $state(false);

	function setFontSize(size: string): void {
		localSettings.set('markdownViewerFontSize', size);
	}
</script>

<Popover.Root bind:open={menuOpen}>
	<Popover.Trigger>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={m.editor_settings_button_label()}
			title={m.editor_settings_button_label()}
		>
			<Settings class="w-4 h-4" />
		</Button>
	</Popover.Trigger>

	<Popover.Content class="w-72 p-0" align="end" sideOffset={8}>
		<div class="bg-card text-foreground rounded-md border border-border divide-y divide-border">
			<div class="flex items-center justify-between px-4 py-3">
				<div class="text-sm font-medium text-foreground">
					{m.settings_appearance_settings_code_editor_font_size_label()}
				</div>
				<Select.Root
					type="single"
					value={localSettings.markdownViewerFontSize}
					onValueChange={(value) => {
						if (value) setFontSize(value);
					}}
				>
					<Select.Trigger class="w-[80px]" size="sm">
						{localSettings.markdownViewerFontSize}px
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

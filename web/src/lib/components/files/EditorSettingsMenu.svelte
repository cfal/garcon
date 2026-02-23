<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import * as Select from '$lib/components/ui/select';
	import Settings from '@lucide/svelte/icons/settings';
	import { getPreferences } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	const preferences = getPreferences();
	const fontSizeOptions = ['10', '11', '12', '13', '14', '15', '16', '18', '20'];

	let menuOpen = $state(false);

	function setCodeEditorFontSize(size: string): void {
		preferences.setPreference('codeEditorFontSize', size);
	}

	function toggleWordWrap(): void {
		preferences.setPreference('codeEditorWordWrap', !preferences.codeEditorWordWrap);
	}

	function toggleLineNumbers(): void {
		preferences.setPreference('codeEditorLineNumbers', !preferences.codeEditorLineNumbers);
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
					value={preferences.codeEditorFontSize}
					onValueChange={(value) => {
						if (value) setCodeEditorFontSize(value);
					}}
				>
					<Select.Trigger class="w-[80px]" size="sm">
						{preferences.codeEditorFontSize}px
					</Select.Trigger>
					<Select.Content>
						{#each fontSizeOptions as size}
							<Select.Item value={size} label="{size}px">{size}px</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex items-center justify-between px-4 py-3">
				<div class="text-sm font-medium text-foreground">
					{m.settings_appearance_settings_code_editor_word_wrap_label()}
				</div>
				<Switch
					checked={preferences.codeEditorWordWrap}
					onCheckedChange={toggleWordWrap}
					aria-label={m.settings_appearance_settings_code_editor_word_wrap_label()}
				/>
			</div>

			<div class="flex items-center justify-between px-4 py-3">
				<div class="text-sm font-medium text-foreground">
					{m.settings_appearance_settings_code_editor_line_numbers_label()}
				</div>
				<Switch
					checked={preferences.codeEditorLineNumbers}
					onCheckedChange={toggleLineNumbers}
					aria-label={m.settings_appearance_settings_code_editor_line_numbers_label()}
				/>
			</div>
		</div>
	</Popover.Content>
</Popover.Root>

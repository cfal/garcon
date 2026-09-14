<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuCheckboxItem,
		DropdownMenuSeparator,
		DropdownMenuSub,
		DropdownMenuSubTrigger,
		DropdownMenuSubContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
	} from '$lib/components/ui/dropdown-menu';
	import Settings from '@lucide/svelte/icons/settings';
	import { MediaQuery } from 'svelte/reactivity';
	import { getLocalSettings } from '$lib/context';
	import { FONT_SIZE_OPTIONS } from '$lib/utils/font-size.js';
	import * as m from '$lib/paraglide/messages.js';

	const localSettings = getLocalSettings();
	const narrow = new MediaQuery('(max-width: 480px)');
	let trigger = $state<HTMLElement | null>(null);
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		bind:ref={trigger}
		class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		aria-label={m.editor_settings_button_label()}
		title={m.editor_settings_button_label()}
	>
		<Settings class="size-4" />
	</DropdownMenuTrigger>
	<DropdownMenuContent class="w-56" align="end" getFocusReturnTarget={() => trigger}>
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<span class="flex min-w-0 flex-1 items-center justify-between gap-4">
					<span>{m.settings_appearance_settings_code_editor_font_size_label()}</span>
					<span class="text-xs text-muted-foreground">{localSettings.codeEditorFontSize}px</span>
				</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent class="w-36" side={narrow.current ? 'bottom' : 'right'} align="end">
				<DropdownMenuRadioGroup
					value={localSettings.codeEditorFontSize}
					onValueChange={(value) => localSettings.set('codeEditorFontSize', value)}
				>
					{#each FONT_SIZE_OPTIONS as size (size)}
						<DropdownMenuRadioItem value={size} closeOnSelect={false}
							>{size}px</DropdownMenuRadioItem
						>
					{/each}
				</DropdownMenuRadioGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
		<DropdownMenuSeparator />
		<DropdownMenuCheckboxItem
			checked={localSettings.codeEditorWordWrap}
			onCheckedChange={(value) => localSettings.set('codeEditorWordWrap', value)}
			closeOnSelect={false}
			>{m.settings_appearance_settings_code_editor_word_wrap_label()}</DropdownMenuCheckboxItem
		>
		<DropdownMenuCheckboxItem
			checked={localSettings.codeEditorLineNumbers}
			onCheckedChange={(value) => localSettings.set('codeEditorLineNumbers', value)}
			closeOnSelect={false}
			>{m.settings_appearance_settings_code_editor_line_numbers_label()}</DropdownMenuCheckboxItem
		>
		<DropdownMenuSeparator />
		<DropdownMenuCheckboxItem
			checked={localSettings.codeEditorVimMode}
			onCheckedChange={(value) => localSettings.set('codeEditorVimMode', value)}
			closeOnSelect={false}
			>{m.settings_appearance_settings_code_editor_vim_mode_label()}</DropdownMenuCheckboxItem
		>
	</DropdownMenuContent>
</DropdownMenu>

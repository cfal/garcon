<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import Settings from '@lucide/svelte/icons/settings';

	interface FileTreeSettingsMenuProps {
		showHiddenFiles: boolean;
		foldersFirst: boolean;
		onShowHiddenFilesChange: (enabled: boolean) => void;
		onFoldersFirstChange: (enabled: boolean) => void;
	}

	let {
		showHiddenFiles,
		foldersFirst,
		onShowHiddenFilesChange,
		onFoldersFirstChange,
	}: FileTreeSettingsMenuProps = $props();

	let menuOpen = $state(false);
</script>

<Popover.Root bind:open={menuOpen}>
	<Popover.Trigger>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="File tree settings"
			title="File tree settings"
		>
			<Settings class="w-4 h-4" />
		</Button>
	</Popover.Trigger>

	<Popover.Content class="w-72 p-0" align="end" sideOffset={8}>
		<div class="bg-card text-foreground rounded-md border border-border divide-y divide-border">
			<div class="flex items-center justify-between px-4 py-3">
				<div class="text-sm font-medium text-foreground">Folders first</div>
				<Switch
					checked={foldersFirst}
					onCheckedChange={(checked) => onFoldersFirstChange(Boolean(checked))}
					aria-label="Folders first"
				/>
			</div>

			<div class="flex items-center justify-between px-4 py-3">
				<div class="text-sm font-medium text-foreground">Show hidden files</div>
				<Switch
					checked={showHiddenFiles}
					onCheckedChange={(checked) => onShowHiddenFilesChange(Boolean(checked))}
					aria-label="Show hidden files"
				/>
			</div>
		</div>
	</Popover.Content>
</Popover.Root>

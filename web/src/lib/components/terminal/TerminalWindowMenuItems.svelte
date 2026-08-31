<script lang="ts">
	import Clipboard from '@lucide/svelte/icons/clipboard';
	import Pencil from '@lucide/svelte/icons/pencil';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Settings from '@lucide/svelte/icons/settings';
	import Square from '@lucide/svelte/icons/square';
	import {
		DropdownMenuItem,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuSeparator,
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import {
		getLocalSettings,
		getNotifications,
		getTerminalRegistry,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import { FONT_SIZE_OPTIONS, isFontSizeOption } from '$lib/utils/font-size.js';
	import { terminalSurfaceId } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	let { terminalId, onRename }: { terminalId: string; onRename: () => void } = $props();

	const terminals = getTerminalRegistry();
	const workspace = getWorkspaceCoordinator();
	const localSettings = getLocalSettings();
	const notifications = getNotifications();
	const session = $derived(terminals.sessions[terminalId] ?? null);
	const canReattach = $derived(
		session?.attachmentState === 'taken-over' ||
			session?.attachmentState === 'unavailable' ||
			session?.attachmentState === 'detached',
	);

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.terminal_unavailable());
	}

	async function paste(): Promise<void> {
		if (!session) return;
		try {
			const terminalRuntime = terminals.ensureRuntime(terminalId);
			if (!(await terminalRuntime.pasteFromClipboard())) {
				notifications.error(terminalRuntime.clipboardMessage || m.shell_errors_clipboard_failed());
			}
		} catch (error) {
			notifyFailure(error);
		}
	}

	function setFontSize(size: string): void {
		if (!isFontSizeOption(size)) return;
		localSettings.set('terminalFontSize', size);
	}

	function terminate(): void {
		void workspace.terminateTerminalSession(terminalId).catch(notifyFailure);
	}
</script>

{#if canReattach}
	<DropdownMenuItem onSelect={() => terminals.reattach(terminalId)}>
		<RefreshCw />
		{m.terminal_reattach()}
	</DropdownMenuItem>
{/if}
<DropdownMenuItem disabled={!session} onSelect={onRename}>
	<Pencil />
	{m.terminal_rename()}
</DropdownMenuItem>
<DropdownMenuItem disabled={!session} onSelect={() => void paste()}>
	<Clipboard />
	{m.terminal_paste()}
</DropdownMenuItem>
<DropdownMenuSub>
	<DropdownMenuSubTrigger>
		<Settings />
		<span class="flex min-w-0 flex-1 items-center justify-between gap-4">
			<span>{m.terminal_font_size()}</span>
			<span class="text-xs text-muted-foreground">{localSettings.terminalFontSize}px</span>
		</span>
	</DropdownMenuSubTrigger>
	<DropdownMenuSubContent class="w-36">
		<DropdownMenuRadioGroup value={localSettings.terminalFontSize} onValueChange={setFontSize}>
			{#each FONT_SIZE_OPTIONS as size (size)}
				<DropdownMenuRadioItem value={size} closeOnSelect={false}>
					{size}px
				</DropdownMenuRadioItem>
			{/each}
		</DropdownMenuRadioGroup>
	</DropdownMenuSubContent>
</DropdownMenuSub>
<DropdownMenuSeparator />
<DropdownMenuItem
	variant="destructive"
	disabled={!session || workspace.isSurfaceCloseBlocked(terminalSurfaceId(terminalId))}
	onSelect={terminate}
>
	<Square />
	{m.terminal_terminate()}
</DropdownMenuItem>

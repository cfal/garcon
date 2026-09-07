<script lang="ts">
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import FileText from '@lucide/svelte/icons/file-text';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		disabled: boolean;
		canAttachImages: boolean;
		attachImagesTooltip: string;
		onAddImage: () => void;
		onOpenSnippetPalette: () => void;
	}

	let { disabled, canAttachImages, attachImagesTooltip, onAddImage, onOpenSnippetPalette }: Props =
		$props();

	function deferSnippetPaletteOpen(): void {
		// Lets the dropdown settle before the modal palette claims focus.
		queueMicrotask(onOpenSnippetPalette);
	}
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		{disabled}
		class="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
		title={m.snippets_add_to_prompt()}
		aria-label={m.snippets_add_to_prompt()}
	>
		<Plus class="size-4" />
	</DropdownMenuTrigger>
	<DropdownMenuContent
		align="start"
		side="top"
		sideOffset={8}
		collisionPadding={8}
		class="w-64 max-w-[calc(100vw-1rem)]"
	>
		<DropdownMenuItem onclick={onAddImage} disabled={!canAttachImages} class="items-start">
			<ImagePlus class="mt-0.5 size-4" />
			<div class="min-w-0">
				<div class="font-medium">{m.chat_composer_add_image()}</div>
				<div class="text-xs text-muted-foreground">
					{canAttachImages ? m.chat_composer_attach_image_files() : attachImagesTooltip}
				</div>
			</div>
		</DropdownMenuItem>

		<DropdownMenuItem onclick={deferSnippetPaletteOpen} class="items-start">
			<FileText class="mt-0.5 size-4" />
			<div class="min-w-0">
				<div class="font-medium">{m.snippets_menu_title()}</div>
				<div class="text-xs text-muted-foreground">{m.snippets_menu_description()}</div>
			</div>
		</DropdownMenuItem>
	</DropdownMenuContent>
</DropdownMenu>

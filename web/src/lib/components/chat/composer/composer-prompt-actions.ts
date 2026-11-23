import type { Component } from 'svelte';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import FileText from '@lucide/svelte/icons/file-text';
import Maximize2 from '@lucide/svelte/icons/maximize-2';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Square from '@lucide/svelte/icons/square';
import * as m from '$lib/paraglide/messages.js';
import type { PromptActionId } from '$lib/chat/composer/composer-toolbar-layout';

export interface ComposerPromptAction {
	id: PromptActionId;
	label: string;
	description?: string;
	icon: Component<{ class?: string }>;
	disabled: boolean;
	active?: boolean;
	run: () => void;
}

export interface PromptActionOptions {
	canAttachImages: boolean;
	attachImagesTooltip: string;
	onAddImage: () => void;
	onOpenSnippetPalette?: () => void;
	onOpenExpandedEditor?: () => void;
	onRefinePrompt?: () => void;
	canRefinePrompt?: boolean;
	isPromptRefinementPending?: boolean;
	isPromptTransformPending?: boolean;
	addMenuDisabled?: boolean;
	showAddMenu?: boolean;
}

export function composerPromptActions(options: PromptActionOptions): ComposerPromptAction[] {
	const disabled = Boolean(options.addMenuDisabled || options.isPromptTransformPending);
	const actions: ComposerPromptAction[] = [];
	if (options.showAddMenu !== false) {
		actions.push({
			id: 'image',
			label: m.chat_composer_add_image(),
			icon: ImagePlus,
			description: options.canAttachImages
				? m.chat_composer_attach_image_files()
				: options.attachImagesTooltip,
			disabled: disabled || !options.canAttachImages,
			run: options.onAddImage,
		});
		if (options.onOpenSnippetPalette)
			actions.push({
				id: 'snippet',
				label: m.snippets_menu_title(),
				icon: FileText,
				description: m.snippets_menu_description(),
				disabled,
				run: options.onOpenSnippetPalette,
			});
	}
	if (options.onOpenExpandedEditor)
		actions.push({
			id: 'expand',
			label: m.chat_composer_open_expanded_editor(),
			icon: Maximize2,
			disabled,
			run: options.onOpenExpandedEditor,
		});
	if (options.onRefinePrompt)
		actions.push({
			id: 'refine',
			label: options.isPromptRefinementPending
				? m.prompt_refinement_cancel()
				: m.prompt_refinement_refine(),
			icon: options.isPromptRefinementPending ? Square : Sparkles,
			active: options.isPromptRefinementPending,
			disabled:
				!options.isPromptRefinementPending &&
				(!options.canRefinePrompt || Boolean(options.isPromptTransformPending)),
			run: options.onRefinePrompt,
		});
	return actions;
}

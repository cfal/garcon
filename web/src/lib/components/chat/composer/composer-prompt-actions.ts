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
	image?: {
		supported: boolean;
		unavailableReason: string;
		onSelect: () => void;
	};
	onOpenSnippetPalette?: () => void;
	onOpenExpandedEditor?: () => void;
	onRefinePrompt?: () => void;
	canRefinePrompt?: boolean;
	isPromptRefinementPending?: boolean;
	isPromptTransformPending?: boolean;
	editingDisabled?: boolean;
}

export function composerPromptActions(options: PromptActionOptions): ComposerPromptAction[] {
	const disabled = Boolean(options.editingDisabled || options.isPromptTransformPending);
	const actions: ComposerPromptAction[] = [];
	if (options.onOpenSnippetPalette) {
		actions.push({
			id: 'snippet',
			label: m.snippets_menu_title(),
			icon: FileText,
			description: m.snippets_menu_description(),
			disabled,
			run: options.onOpenSnippetPalette,
		});
	}
	if (options.image) {
		actions.push({
			id: 'image',
			label: m.chat_composer_add_image(),
			icon: ImagePlus,
			description: options.image.supported
				? m.chat_composer_attach_image_files()
				: options.image.unavailableReason,
			disabled: disabled || !options.image.supported,
			run: options.image.onSelect,
		});
	}
	if (options.onRefinePrompt) {
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
	}
	if (options.onOpenExpandedEditor) {
		actions.push({
			id: 'expand',
			label: m.chat_composer_open_expanded_editor(),
			icon: Maximize2,
			disabled,
			run: options.onOpenExpandedEditor,
		});
	}
	return actions;
}

<script lang="ts">
	import { ThemeController, type ThemeControllerDeps } from '../theme-controller.svelte.js';
	import type { ThemePreference } from '../themes.js';
	import { untrack } from 'svelte';

	interface ThemeControllerTestHostProps {
		initialPreference: ThemePreference;
		setTerminalPresentation: ThemeControllerDeps['setTerminalPresentation'];
		setEditorPresentation: ThemeControllerDeps['setEditorPresentation'];
		reportError: ThemeControllerDeps['reportError'];
	}

	let {
		initialPreference,
		setTerminalPresentation,
		setEditorPresentation,
		reportError,
	}: ThemeControllerTestHostProps = $props();
	let preference = $state(untrack(() => initialPreference));
	let terminalAppearance = $state(false);

	new ThemeController({
		getPreference: () => preference,
		getTerminalAppearance: () => terminalAppearance,
		setTerminalPresentation: (presentation) => setTerminalPresentation(presentation),
		setEditorPresentation: (presentation) => setEditorPresentation(presentation),
		reportError: (message) => reportError(message),
	});

	export function setPreference(next: ThemePreference): void {
		preference = next;
	}

	export function setTerminalAppearance(enabled: boolean): void {
		terminalAppearance = enabled;
	}
</script>

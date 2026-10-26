<script lang="ts">
	import { SYSTEM_EDITOR_FONT, type FontPreference } from '$lib/theme/fonts.js';
	import {
		getTypographySurface,
		typographyFontOverride,
		type TypographySurface,
		type FontSizePreference,
	} from '$lib/theme/typography.js';

	let {
		surface,
		font,
		size,
	}: { surface: TypographySurface; font: FontPreference; size: FontSizePreference } = $props();
	const baseSize = $derived(getTypographySurface(surface).defaultSize);
	const pixels = $derived(size === 'default' ? baseSize : Number(size));
	const family = $derived.by(() => {
		if (font !== 'default') return typographyFontOverride(surface, font);
		switch (surface) {
			case 'code-editor':
			case 'expanded-editor':
				return SYSTEM_EDITOR_FONT;
			case 'chat-code':
			case 'code-diff':
				return 'var(--system-code-font)';
			case 'terminal':
				return '"Monaspace Neon NF", var(--system-code-font)';
			default:
				return 'var(--system-ui-font)';
		}
	});
	const codeSample =
		"const message = 'Hello';\nfunction greet(name) {\n  return message + ', ' + name;\n}";
</script>

<div
	data-font-preview
	class="h-48 min-w-0 overflow-auto rounded-md border border-border bg-background p-3 text-foreground"
	style:font-family={family}
	style:font-size={`${pixels}px`}
	style:line-height="1.5"
>
	{#if surface === 'interface'}
		<div class="flex items-center justify-between gap-3 border-b border-border pb-2">
			<strong>Workspace</strong><span>Settings</span>
		</div>
		<div class="py-2">Files &nbsp; Search &nbsp; History</div>
		<div style:font-size={`${(pixels * 12) / 14}px`} class="text-muted-foreground">
			Ready &middot; All changes saved
		</div>
	{:else if surface === 'chat-list'}
		<strong>Update the workspace</strong>
		<p style:font-size={`${(pixels * 13) / 14}px`}>The changes are ready.</p>
		<p class="text-muted-foreground" style:font-size={`${(pixels * 11) / 14}px`}>
			Today &middot; 2 minutes ago
		</p>
	{:else if surface === 'chat-feed'}
		<strong style:font-size={`${pixels * 1.25}px`}>A clearer view</strong>
		<p>The workspace keeps the conversation, files, and results together.</p>
		<p><strong>Important details</strong> and <em>small observations</em>.</p>
	{:else if surface === 'chat-output'}
		<p>Found 3 matching files.</p>
		<p>The configuration is valid. No changes are required.</p>
	{:else if surface === 'expanded-editor'}
		<p>Describe the next change.</p>
		<p>Keep the existing behavior, and make the result easy to read.</p>
	{:else if surface === 'code-diff'}
		<pre style:font-family="inherit" class="whitespace-pre-wrap">  const total = items.length;
- return total;
+ return total + 1;</pre>
		<p style:font-size={`${size === 'default' ? 11 : pixels}px`}>+ Inline change</p>
		<p style:font-size={`${size === 'default' ? 13 : pixels}px`}>Conflict: keep both changes</p>
	{:else if surface === 'terminal'}
		<pre style:font-family="inherit" class="whitespace-pre-wrap">$ git status --short
 M src/example.ts
<strong>Ready</strong>  0123456789
┌──────────┐
│ terminal │
└──────────┘</pre>
	{:else}
		<pre style:font-family="inherit" class="whitespace-pre-wrap">{codeSample}</pre>
		{#if surface === 'chat-code'}<p style:font-size={`${size === 'default' ? 11 : pixels}px`}>
				$ bun run test
			</p>{/if}
	{/if}
</div>

# Files Responsive Details Policy Design

Status: Implemented and reviewed

Repository baseline: `120be62edd16e158e81da1e3e03c06ae425d2571`

Research date: 2026-07-31

Parent design: `FILES_DETAILS_ROW_DESIGN.md`

## Summary

The implemented Files details-row presentation will become the automatic narrow-container layout instead of a purely manual view mode. The popup checkbox will be renamed from `Show details in row` to `Always use detailed rows`.

The persisted value will describe user policy, not the currently rendered layout:

- `responsive`: render columns when the configured metadata columns fit and detailed rows when they do not.
- `always-details`: render detailed rows at every container width.

The active `columns | details` mode will be derived in `FileTree.svelte` from that preference, the Files container width, and the configured metadata fields. Width observation will reuse the same Svelte attachment and component-local derivation pattern used by Git Workbench. The store will not own container width or resolved presentation state.

The existing virtual host, virtual controller, scroll element, interaction state, and focusable row roots will remain mounted across responsive changes. A width transition will feed the same mode-aware geometry path already used by the details implementation, preserving the visible logical anchor or physical end.

Detailed rows will also change their internal alignment. The file or folder icon will be 32 px tall and centered beside the complete two-line text block, rather than sitting only beside the title. The disclosure control remains a separate fixed-width rail; the title and subtitle become one stacked content column.

This document supersedes the parent design wherever it says that:

- the store persists the active `FileTreeViewMode`;
- column mode is always the default presentation;
- automatic width selection is a non-goal or rejected alternative;
- the checkbox is labeled `Show details in row`;
- the subtitle independently pads itself past a title-only icon row.

The parent design remains authoritative for metadata formatting, sorting, accessibility, fixed virtual row heights, anchor restoration, and the decision to retain one virtualized host.

## Problem

The column presentation has a 520 px minimum whenever at least one metadata column is enabled. Files can be hosted in main, sidebar, dialog, and mobile surfaces whose width is controlled by workspace layout rather than the browser viewport. When the allocated host becomes narrower than the column contract, the inner table remains wide and the metadata columns are clipped or pushed outside the visible area.

The current persisted `viewMode` cannot solve this automatically. It conflates two different questions:

- What behavior did the user request across widths?
- Which presentation fits this particular Files container now?

The current details row also visually splits one conceptual item incorrectly. The 16 px file or folder icon belongs to the title line while the subtitle is indented beneath it. In a 44/52 px two-line row, that makes the icon look attached only to the first line rather than representing the entire entry.

## Goals

- Automatically render detailed rows when enabled metadata columns do not fit the Files container.
- Rename the checkbox to `Always use detailed rows` and persist it as an override policy.
- Follow the established Git Workbench container-observation pattern.
- Keep width state local to the Files component tree.
- Keep active view mode derived rather than synchronized through effects or callbacks.
- Use the existing 520 px multi-column minimum as the responsive threshold.
- Avoid a second magic breakpoint that can drift from the table width contract.
- Keep a name-only tree in columns because a detail subtitle would contain no configured metadata.
- Let both name-only columns and detailed rows shrink below 240 px without being clipped by their own minimum width.
- Keep sort controls and menu section labels aligned with the resolved presentation.
- Preserve focus, selection, expansion, scroll anchor, physical end, and virtual DOM identity while crossing the threshold.
- Make the details-mode file or folder icon span the visual height of both 16 px text lines.
- Preserve the existing compact 16 px icon in column mode.

## Non-goals

- No user-configurable breakpoint.
- No `Always use columns` override.
- No viewport media query; the decision is based on the Files host width.
- No per-project, per-chat, or per-surface preference.
- No duplicated column/detail metadata settings.
- No variable-height rows or wrapping subtitle.
- No separate narrow and wide virtualizers.
- No debounce, hysteresis, or resize animation in the first implementation.
- No server, API, WebSocket, shared file contract, or database change.
- No new dependency.

## Current System

### Files ownership

| Concern | Current owner | Follow-up impact |
| --- | --- | --- |
| Persisted view mode | `web/src/lib/files/tree/file-tree.svelte.ts` | Replace active mode with a view preference. |
| Persistence key | `web/src/lib/utils/local-persistence.ts` | Replace `fileTreeViewMode` with `fileTreeViewPreference`. |
| Shared Files root | `web/src/lib/components/files/FileTree.svelte` | Observe allocated width and derive the active mode. |
| Toolbar | `web/src/lib/components/files/FileTreeToolbar.svelte` | Receive resolved mode for its menu. |
| Popup | `web/src/lib/components/files/FileTreeMenuContent.svelte` | Render override state from preference and layout controls from resolved mode. |
| View policy | `web/src/lib/components/files/file-tree-view-profile.ts` | Own active mode, threshold, minimum widths, and pure resolution. |
| Virtual surface | `web/src/lib/components/files/FileTreeVirtualRows.svelte` | Receive resolved mode rather than reading store mode. |
| Row | `web/src/lib/components/files/FileTreeRow.svelte` | Put icon beside the entire text stack. |
| Subtitle | `web/src/lib/components/files/FileTreeRowSubtitle.svelte` | Remove self-managed icon/disclosure indentation. |
| Width test harness | `web/src/lib/components/shared/__tests__/resize-observer-harness.ts` | Reuse without a new test double. |

At the baseline, `FileTreeStore.viewMode` is persisted as `columns | details`, and both the toolbar menu and virtual surface read it directly. The virtual surface creates its profile and numeric geometry from that value.

### Workbench precedent

`web/src/lib/components/shared/container-presentation.ts` already provides:

```ts
export function observeContainerWidth(onWidth: (width: number) => void): Attachment<HTMLElement> {
	return (element) => {
		let lastWidth = -1;
		const publish = (width: number): void => {
			if (!Number.isFinite(width) || width < 0 || width === lastWidth) return;
			lastWidth = width;
			onWidth(width);
		};

		publish(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === 'undefined') return;

		const observer = new ResizeObserver(([entry]) => {
			if (entry) publish(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	};
}
```

`GitWorkbench.svelte` keeps one measured value and derives presentation:

```ts
let containerWidth = $state(0);
const observeWorkbenchWidth = observeContainerWidth((width) => {
	containerWidth = width;
});
let containerPresentation = $derived<'narrow' | 'wide'>(
	isMobile || containerPresentationForWidth(containerWidth, gitContainerBreakpoints) !== 'wide'
		? 'narrow'
		: 'wide',
);
```

Its shrinkable root uses `min-w-0` and `{@attach observeWorkbenchWidth}`. `GitWorkbench.test.ts` changes observed width from 1,100 px to 700 px and asserts that the same virtual diff root survives the presentation transition.

Files will reuse the measurement attachment and stable-subtree testing pattern. It will not reuse `containerPresentationForWidth`, because Files has two presentation modes, a user override, and a metadata-dependent exception rather than Git's generic narrow/compact/wide contract.

### Svelte 5

The repository uses Svelte 5 and already uses attachments for container observers. Svelte documents attachments as element-mount behavior that can return teardown cleanup, which matches the shared observer helper: <https://svelte.dev/docs/svelte/%40attach>.

The responsive mode is a `$derived` value. No `$effect` will mirror preference or width into another mutable mode variable.

## Resolved Decisions

### Persist policy, derive presentation

The domain store will own an explicit preference:

```ts
export const FILE_TREE_VIEW_PREFERENCES = ['responsive', 'always-details'] as const;
export type FileTreeViewPreference = (typeof FILE_TREE_VIEW_PREFERENCES)[number];

export class FileTreeStore {
	viewPreference = $state<FileTreeViewPreference>('responsive');

	setViewPreference(preference: FileTreeViewPreference): void {
		if (preference === this.viewPreference) return;
		this.viewPreference = preference;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeViewPreference, preference);
	}

	setAlwaysUseDetailedRows(always: boolean): void {
		this.setViewPreference(always ? 'always-details' : 'responsive');
	}
}
```

The checkbox adapter accepts a boolean because that is the menu primitive's contract. The stored state remains an exhaustive policy discriminator.

The presentation module will own the runtime mode:

```ts
export const FILE_TREE_VIEW_MODES = ['columns', 'details'] as const;
export type FileTreeViewMode = (typeof FILE_TREE_VIEW_MODES)[number];
```

This removes view geometry from the domain store without creating loosely related booleans.

### Responsive resolution

The existing 520 px multi-column minimum becomes the single responsive boundary:

```ts
export const FILE_TREE_NAME_ONLY_MINIMUM_WIDTH_PX = 240;
export const FILE_TREE_MULTI_COLUMN_MINIMUM_WIDTH_PX = 520;
export const FILE_TREE_DETAILS_MINIMUM_WIDTH_PX = 240;

interface ResolveFileTreeViewModeOptions {
	readonly preference: FileTreeViewPreference;
	readonly containerWidth: number;
	readonly visibleColumnKeys: readonly FileTreeColumnKey[];
}

export function resolveFileTreeViewMode({
	preference,
	containerWidth,
	visibleColumnKeys,
}: ResolveFileTreeViewModeOptions): FileTreeViewMode {
	if (preference === 'always-details') return 'details';
	const hasMetadata = visibleColumnKeys.some((key) => key !== 'name');
	if (!hasMetadata) return 'columns';
	return containerWidth < FILE_TREE_MULTI_COLUMN_MINIMUM_WIDTH_PX ? 'details' : 'columns';
}
```

The comparison is strict. At 520 px, columns fit their declared minimum and remain active. At 519.5 px, detailed rows activate.

When all optional metadata fields are disabled, responsive mode stays in columns at every width. The details layout would otherwise spend vertical space on `No details available` without recovering useful information. The single name column will be allowed to shrink with the container.

### No hysteresis or debounce

The observer attaches to the externally allocated Files root, not the minimum-width table child. Both the Files root and its parent flex item will use `min-w-0`, and the inner table width will be capped to the container. Switching presentation therefore cannot enlarge the observed element and create a feedback loop.

Only the primitive resolved mode reaches the profile and virtual controller. Width updates that remain on the same side of 520 px do not change geometry. A resize drag crosses the threshold once unless the user deliberately moves back across it.

Hysteresis would add history-dependent state and two boundaries without evidence that they are needed. It is deferred unless browser testing demonstrates oscillation.

### Initial presentation

`containerWidth` starts at `0`, matching Workbench. With the default metadata fields enabled, responsive mode initially resolves to details. `observeContainerWidth` immediately publishes `getBoundingClientRect().width` when the root mounts and then subscribes to `ResizeObserver`.

This biases the unmeasured first frame toward the safe narrow presentation and avoids briefly exposing clipped columns. A wide container resolves to columns as soon as its initial measurement is published.

### FileTree owns resolution

`FileTree.svelte` is the closest shared owner of the toolbar and virtual rows, so it owns the observed width and resolved mode:

```svelte
<script lang="ts">
	import { observeContainerWidth } from '$lib/components/shared/container-presentation.js';
	import {
		resolveFileTreeViewMode,
		type FileTreeViewMode,
	} from './file-tree-view-profile.js';

	let containerWidth = $state(0);
	const observeFileTreeWidth = observeContainerWidth((width) => {
		containerWidth = width;
	});
	let viewMode = $derived<FileTreeViewMode>(
		resolveFileTreeViewMode({
			preference: store.viewPreference,
			containerWidth,
			visibleColumnKeys: store.visibleColumnKeys,
		}),
	);
</script>

<div
	class="flex h-full min-h-0 min-w-0 flex-col bg-card"
	data-file-tree-root
	data-file-tree-layout={viewMode}
	{@attach observeFileTreeWidth}
>
	<FileTreeToolbar {store} {viewMode} />
	<!-- Existing states remain here. -->
	<FileTreeVirtualRows {store} {viewMode} ... />
</div>
```

`FilesPanel.svelte` will also add `min-w-0` to its immediate flex child so the observed root receives the actual host allocation instead of a descendant's min-content contribution.

Width is not added to `FileTreeStore`, `FileTreeVirtualController`, a context, or an application-wide store.

### Resolved mode is passed explicitly

`FileTreeToolbar`, `FileTreeMenuContent`, and `FileTreeVirtualRows` will accept a required `viewMode: FileTreeViewMode` prop.

`FileTreeVirtualRows` will replace:

```ts
mode: store.viewMode
fileTreeViewGeometry(store.viewMode)
```

with:

```ts
mode: viewMode
fileTreeViewGeometry(viewMode)
```

The virtual controller still receives numeric geometry only. It does not learn about preferences, breakpoints, metadata visibility, or ResizeObserver.

### Menu semantics

The checkbox reflects only the override:

```svelte
<DropdownMenuCheckboxItem
	checked={store.viewPreference === 'always-details'}
	closeOnSelect={false}
	onCheckedChange={(checked) => store.setAlwaysUseDetailedRows(Boolean(checked))}
>
	{m.filetree_always_use_detailed_rows()}
</DropdownMenuCheckboxItem>
```

The rest of the menu follows `viewMode`:

- Automatic narrow details mode shows the `Details` field label and sort radio groups.
- Wide responsive mode shows the `Columns` label and reset-width action.
- The checkbox remains unchecked during automatic narrow details mode.
- Checking the override while narrow does not change the current layout but pins it for later widening.
- Unchecking the override while narrow also does not change the current layout; widening later restores columns.
- Unchecking the override while wide changes details to columns immediately.

The old `filetree_show_details_in_row` message is replaced by:

```json
"filetree_always_use_detailed_rows": "Always use detailed rows"
```

Paraglide output must be regenerated after the message change.

### Minimum widths

`FileTreeViewProfile.minimumTableWidth` will become a numeric `minimumTableWidthPx`, using the constants in the presentation module. The DOM will cap every mode to the actual host:

```svelte
<div role="presentation" style:min-width={`min(${profile.minimumTableWidthPx}px, 100%)`}>
```

This removes the existing mobile-only branch. It prevents detailed rows and the responsive name-only column from overflowing a host narrower than 240 px. Multi-column mode normally appears only at or above 520 px, but the cap also keeps its initial and transition frames contained.

### Details icon spans both text lines

The details row will use three horizontal regions inside the row header:

- Indentation and directory disclosure rail.
- One 32 px file or folder icon centered across the two-line block.
- One `min-w-0` text stack containing the title line and subtitle line.

Synthetic parent and child-status rows use the same presentation-sized icon rail so their labels
remain horizontally aligned with ordinary entries. The parent glyph consumes the full 16/32 px
rail; loading and error glyphs remain compact inside a centered 16/32 px rail.

The 32 px icon matches two 16 px lines. The existing 44 px fine-pointer and 52 px coarse-pointer rows leave 6 px or 10 px of vertical breathing room around that block. Virtual geometry does not change.

`FileTreeViewProfile` will expose the icon size as presentation data:

```ts
interface FileTreeViewProfileBase {
	readonly entryIconSizePx: number;
	readonly minimumTableWidthPx: number;
	// Existing grid and accessibility fields remain.
}

// columns
entryIconSizePx: 16,

// details
entryIconSizePx: 32,
```

`FileTreeVirtualRows.svelte` publishes the value beside the existing row variables:

```svelte
style:--file-tree-entry-icon-size={`${profile.entryIconSizePx}px`}
```

Each file/folder icon receives one shared class:

```svelte
<Folder class="file-tree-entry-icon mr-2 shrink-0 text-file-icon-folder" />
```

The virtual surface stylesheet owns the dimensions:

```css
.file-tree-virtual-grid :global(.file-tree-entry-icon) {
	height: var(--file-tree-entry-icon-size);
	width: var(--file-tree-entry-icon-size);
}
```

The row header will put the subtitle inside the same text stack as the title:

```svelte
<div class="flex h-full min-w-0 items-center" data-file-tree-entry-layout>
	<!-- Existing disclosure button or spacer. -->
	<!-- Existing icon selected from entry type. -->
	<div
		class={cn(
			'min-w-0 flex-1',
			profile.mode === 'details' &&
				'grid h-8 grid-cols-[minmax(0,1fr)_24px] grid-rows-[16px_16px]',
		)}
		data-file-tree-entry-text
	>
		<div
			class={cn('flex min-h-0 min-w-0 items-center', profile.mode === 'details' && 'leading-4')}
		>
			<span class="min-w-0 truncate">{entry.name}</span>
		</div>
		{#if profile.mode === 'details'}
			<div class="col-start-1 row-start-2 min-w-0 overflow-hidden">
				<FileTreeRowSubtitle {entry} keys={profile.subtitleKeys} />
			</div>
		{/if}
		{#if entry.type === 'file'}
			<CopyFilePathButton
				path={entry.relativePath}
				class={cn(
					profile.mode === 'columns' && 'ml-1',
					profile.mode === 'details' &&
						'col-start-2 row-span-2 row-start-1 self-center',
				)}
			/>
		{/if}
	</div>
</div>
```

`FileTreeRowSubtitle.svelte` will remove:

```text
pl-[calc(var(--file-tree-disclosure-size)+1.5rem)]
```

The details text stack uses two explicit 16 px tracks, and its title line adopts `leading-4`; `FileTreeRowSubtitle` already uses `leading-4`. A file's 24 px copy action spans both tracks in its own fixed column, so it cannot overlap either line or distort their alignment. The subtitle no longer guesses the width of siblings. Its parent stack establishes alignment directly. Indent guides continue to span the full row header, and the disclosure button remains centered independently from the 32 px icon.

Column mode uses the same markup with a 16 px icon and no subtitle. A file's copy action is one
stable component instance whose placement classes change with the surrounding flex/grid layout, so
its focus and copied state survive responsive transitions. Disclosure, copy-path, activation,
keyboard, focus, selection, and ARIA behavior remain unchanged.

## Persistence and Migration

Replace:

```ts
fileTreeViewMode: 'file-tree-view-mode'
```

with:

```ts
fileTreeViewPreference: 'file-tree-view-preference'
```

Valid stored values are `responsive` and `always-details`; malformed values fall back to `responsive`.

The details-row work is still isolated on the unmerged `files-details` branch at the recorded baseline. The old `file-tree-view-mode` key therefore has no released compatibility contract, and no read-through migration is added. This avoids carrying feature-branch migration code into production. If the original mode key ships independently before this follow-up merges, the implementation must revisit this assumption and map `details` to `always-details` before release.

## Failure Modes

### Observing the wrong element

Risk: observing the 520 px table child reports its own minimum width rather than the clipped host, so responsive mode never activates.

Mitigation: attach the observer to the `FileTree` root, add `min-w-0` through the immediate Files flex chain, and cap the inner minimum width to `100%`.

### Presentation feedback

Risk: changing to details alters the observed width and repeatedly crosses the boundary.

Mitigation: the observed root receives width from its parent; presentation-specific minimum width is confined to a capped descendant. The observer helper also deduplicates identical widths.

### Initial width is unknown

Risk: columns flash in a narrow host before the first observer callback.

Mitigation: initialize width to zero, which resolves the default metadata configuration to details, and use the attachment's immediate bounding-rect publication.

### Override and active layout differ

Risk: a user sees detailed rows while `Always use detailed rows` is unchecked and assumes the checkbox is stale.

Mitigation: the label describes the override rather than the active mode. Details/Columns section labels and available sort controls continue to describe the active mode.

### Resize while scrolled or focused

Risk: crossing 520 px changes header and row geometry while the tree is virtualized.

Mitigation: the resolved mode enters the existing single controller's geometry path. Pre-DOM scroll capture, committed-layout baseline, token guard, logical anchor/end restoration, and stable row keys remain authoritative.

### Repeated threshold crossing

Risk: rapid pane dragging creates repeated geometry work.

Mitigation: measurements within one side of the threshold do not change the derived primitive mode. Each genuine crossing is handled as one existing geometry transition. No logical tree sort or rebuild depends on width.

### Large icon crowds narrow rows

Risk: the 32 px icon and deep indentation leave little text width.

Mitigation: disclosure and icon are fixed-size rails; the text stack remains `min-w-0`, and both title and subtitle truncate. Manual coverage includes deep nesting at widths below 520 px.

## Alternatives Considered

### CSS media query

Rejected because Files width is controlled by workspace hosts, sidebars, dialogs, and split panes. Browser viewport width does not describe the component's available space, and CSS alone cannot update virtual row geometry or menu behavior.

### CSS container query only

Rejected as the sole mechanism because the virtual controller needs a typed numeric geometry input and the menu needs the same resolved semantic mode. A container query would duplicate mode selection between CSS and TypeScript.

### Put width and active mode in FileTreeStore

Rejected because container width is presentation-local and the same global tree store can be shown through different hosts over its lifetime. Persisting or sharing measured width would leak component layout into the Files domain.

### Reuse `containerPresentationForWidth`

Rejected because that helper models fixed narrow/compact/wide breakpoints. Files has a two-mode output, an always-details override, and a no-metadata exception. Reusing the observer attachment but keeping a Files-specific pure resolver preserves the useful pattern without weakening types.

### Persist `columns | details` and override it when narrow

Rejected because `columns` would ambiguously mean either `always columns` or `responsive`. The UI no longer offers an always-columns policy. Persisting the explicit `responsive | always-details` intent makes every state meaningful.

### Boolean `alwaysUseDetailedRows` plus mutable `isNarrow`

Rejected as stored architecture. The checkbox boolean would be valid in isolation, but pairing it with another mutable presentation boolean encourages synchronization. An explicit preference enum, numeric width state, and derived mode are exhaustive and easier to test.

### Hysteresis or debounce

Deferred because the Workbench pattern performs direct container derivation successfully, and Files observes a presentation-independent root. Adding timers or last-mode state would complicate focus and geometry transitions without a reproduced problem.

### Keep the icon at 16 px and only center it vertically

Rejected because the icon would remain visually subordinate to the title line rather than representing the full two-line entry. The requested contract is a 32 px icon matching the title-plus-subtitle height.

### Give the subtitle compensating left padding

Rejected because it encodes disclosure and icon widths a second time. A real text stack aligns title and subtitle structurally and remains correct when the icon size changes.

## Execution Plan

### Replace active-mode persistence with policy persistence

Files:

- `web/src/lib/files/tree/file-tree.svelte.ts`
- `web/src/lib/utils/local-persistence.ts`
- `web/src/lib/files/tree/__tests__/file-tree.test.ts`

Work:

- Add `FileTreeViewPreference` and its value guard.
- Replace `viewMode` with `viewPreference`, defaulting to `responsive`.
- Replace `setViewMode` and `setShowDetailsInRow` with preference methods.
- Replace the persistence key and malformed-value tests.
- Keep sorting, column visibility, and widths unchanged.

Validation:

```sh
bun run --cwd web test -- src/lib/files/tree/__tests__/file-tree.test.ts
```

Rollback: restore the active mode field and old key while leaving presentation components intact.

### Add the pure responsive policy

Files:

- `web/src/lib/components/files/file-tree-view-profile.ts`
- `web/src/lib/components/files/__tests__/file-tree-view-profile.logic.test.ts`

Work:

- Move `FileTreeViewMode` ownership to the presentation module.
- Replace string minimum widths with numeric constants.
- Add `resolveFileTreeViewMode`.
- Add `entryIconSizePx` to both exhaustive profiles.
- Preserve existing grid, filler, subtitle, and accessibility projections.

Assertions:

- Responsive with metadata resolves details at 0, 480, and 519.5 px.
- Responsive with metadata resolves columns at 520 and 900 px.
- Always-details resolves details at every width.
- Responsive name-only resolves columns at 0, 200, and 900 px.
- Column and details profiles expose 16 px and 32 px icons.
- Minimum widths remain 240/520/240 px.

Validation:

```sh
bun run --cwd web test -- src/lib/components/files/__tests__/file-tree-view-profile.logic.test.ts
```

### Resolve mode at the shared Files root

Files:

- `web/src/lib/components/files/FileTree.svelte`
- `web/src/lib/components/files/FileTreeToolbar.svelte`
- `web/src/lib/components/files/FileTreeMenuContent.svelte`
- `web/src/lib/components/files/FileTreeVirtualRows.svelte`
- `web/src/lib/components/files/FilesPanel.svelte`

Work:

- Reuse `observeContainerWidth` through `{@attach}`.
- Add the shrinkability classes and root data attributes.
- Derive mode from preference, width, and visible columns.
- Pass mode explicitly to toolbar, menu, and virtual surface.
- Cap the inner table minimum width to `100%` in all presentations.
- Keep virtual controller inputs numeric.

Rollback: resolve responsive preference to columns unconditionally; no controller rollback is needed.

### Update menu language and behavior

Files:

- `web/messages/en.json`
- generated Paraglide modules
- `web/src/lib/components/files/FileTreeMenuContent.svelte`
- `web/src/lib/components/files/__tests__/FileTree.test.ts`
- `web/src/lib/components/files/__tests__/FileTreeToolbar.test.ts`

Work:

- Replace the old message with `Always use detailed rows`.
- Bind checkbox state to preference.
- Bind section labels, reset action, and sort groups to resolved mode.
- Keep `closeOnSelect={false}`.

Validation:

```sh
cd web && bunx @inlang/paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide
bun run --cwd web test -- \
	src/lib/components/files/__tests__/FileTree.test.ts \
	src/lib/components/files/__tests__/FileTreeToolbar.test.ts
```

### Restructure the details entry layout

Files:

- `web/src/lib/components/files/FileTreeRow.svelte`
- `web/src/lib/components/files/FileTreeRowSubtitle.svelte`
- `web/src/lib/components/files/FileTreeVirtualRows.svelte`
- `web/src/lib/components/files/__tests__/FileTree.test.ts`
- `web/src/lib/components/files/__tests__/FileTreeVirtualRows.test.ts`

Work:

- Publish the icon-size CSS variable from the profile.
- Apply one shared icon class to every file/folder icon variant.
- Put title and subtitle inside one stacked text container with two 16 px tracks.
- Remove subtitle compensation padding.
- Preserve disclosure and copy-button event isolation.

Assertions:

- Column mode publishes a 16 px icon size.
- Details mode publishes a 32 px icon size.
- The same icon element is adjacent to the shared title/subtitle stack.
- Title and subtitle occupy the same `data-file-tree-entry-text` container.
- The details title and subtitle each occupy one 16 px line beside the 32 px icon.
- The copy-path action spans both details tracks in a separate 24 px column.
- The subtitle has no disclosure/icon compensation padding.
- File, folder, expanded folder, image, document, code, and generic icons all consume the shared size rule.
- Disclosure click still expands without activation.
- Copy-path click still does not activate the row.

### Cover responsive virtualization

Files:

- `web/src/lib/components/files/__tests__/FileTree.test.ts`
- `web/src/lib/components/files/__tests__/FileTreeVirtualRows.test.ts`
- `web/src/lib/components/files/__tests__/FileTreeToolbar.test.ts`

Use `installResizeObserverHarness` and `ResizeObserverHarness.emit`, matching Workbench tests.

Representative integration test:

```ts
it('changes responsive presentation without remounting the virtual tree or focused row', async () => {
	const { container } = renderReady(entries(1_000));
	const root = container.querySelector<HTMLElement>('[data-file-tree-root]');
	if (!root) throw new Error('Expected Files root');

	ResizeObserverHarness.emit(root, 700);
	await waitFor(() => expect(root.dataset.fileTreeLayout).toBe('columns'));
	const treegrid = screen.getByRole('treegrid');
	const focusedRow = rowByKey(container, '/workspace/file-000022.ts');
	focusedRow.focus();

	ResizeObserverHarness.emit(root, 480);

	await waitFor(() => expect(root.dataset.fileTreeLayout).toBe('details'));
	expect(screen.getByRole('treegrid')).toBe(treegrid);
	expect(rowByKey(container, '/workspace/file-000022.ts')).toBe(focusedRow);
	expect(document.activeElement).toBe(focusedRow);
});
```

Additional cases:

- Automatic details leaves `Always use detailed rows` unchecked.
- Checking and unchecking the override at 480 px does not leave details mode.
- Widening to 700 px after unchecking restores columns.
- Checking the override at 700 px selects details and keeps it after further width changes.
- Hiding every metadata field selects name-only columns even at 200 px.
- Adding a metadata field at 480 px selects details.
- Automatic details exposes sort key and direction controls.
- Responsive columns expose reset-width and header sorting.
- Crossing the threshold preserves a nonzero logical anchor and the physical end.
- User scrolling during deferred responsive restoration wins.
- Width changes do not call `sortEntries` or rebuild the logical row model.
- The 100,000-row mounted window stays bounded on both sides of the threshold.

Validation:

```sh
bun run --cwd web test -- \
	src/lib/components/files/__tests__/FileTree.test.ts \
	src/lib/components/files/__tests__/FileTreeToolbar.test.ts \
	src/lib/components/files/__tests__/FileTreeVirtualRows.test.ts \
	src/lib/components/files/__tests__/file-tree-view-profile.logic.test.ts \
	src/lib/components/files/__tests__/file-tree-virtual-anchor.logic.test.ts \
	src/lib/components/files/__tests__/file-tree-virtual-layout.logic.test.ts
```

### Complete validation

Run from the repository root:

```sh
bun run check
bun run test
bun run start --port 0 --workspace-dir <fresh-temporary-directory>
```

The startup command must report a listening URL. Use a timeout to stop only the new validation process after startup; do not disturb an existing server.

Manual verification:

- Drag the main and sidebar Files hosts slowly across 520 px.
- Verify no horizontal clipping or feedback oscillation.
- Verify the same focused and selected entry remains stable in both directions.
- Verify a scrolled-to-end directory remains at the end.
- Verify the override at narrow and wide widths.
- Verify name-only responsive behavior.
- Verify the menu controls match the active presentation while the checkbox reflects only the override.
- Verify file, folder, expanded folder, image, document, code, and generic icons are 32 px beside the full two-line details block.
- Verify column icons remain 16 px.
- Verify deep nesting and long names/subtitles truncate without overlap at 240-519 px.
- Verify main, sidebar, dialog, and mobile surfaces in light and dark themes.
- Verify coarse-pointer 52 px rows center the same 32 px icon correctly.
- Rapidly switch chats while Files is visible and verify no focus or scroll jump.

## Test Coverage Matrix

| Area | Test file | Required coverage |
| --- | --- | --- |
| Preference persistence | `web/src/lib/files/tree/__tests__/file-tree.test.ts` | Default, valid values, malformed values, setter persistence. |
| Pure resolution | `file-tree-view-profile.logic.test.ts` | Boundary, override, metadata exception, numeric widths, icon sizes. |
| Width integration | `FileTree.test.ts` | Shared attachment, derived mode, menu semantics, stable DOM identity. |
| Toolbar overflow | `FileTreeToolbar.test.ts` | New label remains reachable and ordered in narrow toolbar. |
| Row layout | `FileTree.test.ts` | Shared text stack, 32 px details icon, 16 px column icon, interactions. |
| Virtual behavior | `FileTreeVirtualRows.test.ts` | Anchor, end, focus, user scroll, bounded mount count. |
| Existing geometry math | Virtual layout/anchor logic tests | Unchanged 28/36 and 44/52 row geometry. |
| Full regression | `bun run test` | All server and web suites. |
| Static validation | `bun run check` | TypeScript, Svelte, lint, architecture. |
| Startup | `bun run start --port 0` | SPA and server compile and listen. |

No server integration test is required because the change is entirely within local browser presentation and local-storage preference behavior. The residual gap is browser-specific resize, layout, and visual rendering; the manual matrix covers it.

## Performance, Accessibility, and Security

Performance:

- Reuses one deduplicating ResizeObserver attachment.
- Does not sort or rebuild semantic rows on width updates.
- Changes virtual geometry only when resolved mode crosses the boundary.
- Adds no second virtualizer or hidden tree.

Accessibility:

- Retains one treegrid and the existing mode-specific header semantics.
- Keeps the row as the roving focus target.
- Keeps directory disclosure and copy buttons keyboard reachable through existing behavior.
- Makes no announcement solely for a responsive visual change; treegrid column count and header semantics update with the resolved mode.
- Enlarging decorative file/folder icons does not add duplicate accessible names.

Security and privacy:

- No new data source, transport, permission, or trust boundary.
- The preference remains local browser state.

## Rollout and Rollback

The follow-up ships with the details feature before that feature reaches the main branch.

Default behavior changes from explicit columns to responsive selection. Wide containers remain visually unchanged. Narrow containers immediately receive detailed rows without requiring a preference change.

Rollback is client-only:

- Resolve `responsive` to columns unconditionally.
- Keep `always-details` as the explicit details override.
- Remove the width attachment and responsive tests if the behavior is withdrawn.
- The existing details renderer and virtual geometry remain valid.

No telemetry is added. Confidence comes from pure boundary tests, ResizeObserver integration tests modeled on Workbench, virtual scroll regressions, full validation, and manual host resizing.

## Implementation and Review Record

The responsive policy and row restructure were implemented in `169d9d3`. The implementation keeps
one `FileTreeVirtualRows` host and one virtual controller while passing the derived presentation mode
through the existing geometry transition path.

The original Kimi K3 review found no admissible defects in the responsive policy, persistence,
container measurement, row structure, menu semantics, or virtual-controller integration. Its two
remaining risks were explicitly browser-specific: first-paint timing and ResizeObserver cadence
during a continuous resize.

The original Claude Opus review found two low-severity issues. Both were accepted:

- Synthetic parent, loading, and error rows did not consume the same presentation-sized icon rail as
  ordinary entries, creating an alignment change between 16 px column icons and 32 px details icons.
- The copy-path interaction test exercised only the initial narrow details presentation after the
  responsive change, so column-mode copy markup no longer had direct interaction coverage.

The review follow-up aligns every synthetic row to the presentation icon rail and exercises the same
file row and copy action before and after a 700 px transition to columns. Final review resumes both
original sessions against the follow-up commit rather than starting unrelated review contexts.

Both resumed sessions then independently found the same low-severity focus issue: the copy action was
rendered as separate mode-specific component instances, so crossing 520 px while that keyboard-reachable
button was focused destroyed it and dropped focus. The finding was accepted. The final follow-up renders
one instance with mode-dependent placement classes and asserts button identity, focus, copied state,
copy behavior, and row activation isolation across the responsive transition. It also closes two
informational matrix gaps by testing that an always-details override remains pinned across later width
changes and that enabling metadata at 480 px changes a name-only column view to details.

The next verification pass confirmed that the shared copy action survives Svelte reconciliation and
that its identity, focus, state, and placement tests discriminate the old behavior. It found no
remaining correctness defect. Both reviewers did identify one visible columns-mode change from the
temporary fix: making the title cell grow moved the copy action from immediately after a short name
to the far edge of the name column. That growth class was unnecessary for truncation because the
title cell already shrinks with `min-w-0` and `overflow-hidden`, so it was removed to preserve the
existing name-adjacent placement without reintroducing the focus defect.

Both original reviewer sessions were resumed once more against `6e91a7e`. Kimi K3 and Claude Opus
independently verified the flex shrink/truncation behavior, stable component identity, details grid
placement, and directory path, and reported no remaining admissible finding.

## Acceptance Criteria

- The popup label is `Always use detailed rows`.
- The persisted state is `responsive | always-details`, not the active mode.
- With metadata enabled, responsive Files uses details below 520 px and columns at or above 520 px.
- With no metadata enabled, responsive Files keeps a shrinkable name-only column layout.
- Always-details uses detailed rows at every width.
- Menu section labels and sort/reset controls follow the resolved mode.
- The checkbox follows only the persisted override.
- Width is observed through the existing shared attachment on a `min-w-0` Files root.
- The inner table cannot force the observed root wider than its host.
- The virtual host, controller, scroll element, interaction state, and focusable row roots survive responsive transitions.
- Responsive transitions preserve selection, expansion, focus, visible anchor, and physical end.
- A later user scroll cancels deferred restoration.
- Responsive width changes do not sort or rebuild the logical tree.
- Details-mode file and folder icons are 32 px and span the two-line text block.
- Column-mode icons remain 16 px.
- Title and subtitle share one structurally aligned text stack without compensating subtitle padding.
- A focused copy-path action preserves its DOM identity, focus, and transient state across responsive transitions.
- All focused tests, `bun run check`, `bun run test`, and fresh startup validation pass.

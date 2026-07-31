# Files Details Row View Design

Status: Implemented and adversarially reviewed

Repository baseline: `991c9da4ec7922f886d44b4b4e312a3347af8fd4`

Research date: 2026-07-31

Responsive follow-up: `FILES_RESPONSIVE_DETAILS_POLICY_DESIGN.md` supersedes this document's persisted active-mode policy, manual-only selection, menu label, minimum-width behavior, and details-row icon alignment. This document remains authoritative for the underlying details presentation and virtual geometry.

## Summary

The Files view will gain a persisted `Show details in row` checkbox in its existing actions menu. The setting selects one of two explicit presentation modes:

- `columns`: the current resizable, sortable treegrid columns.
- `details`: one visual column with the file or folder name on the first line and the selected metadata fields in a subtitle on the second line.

The implementation will use one `FileTreeViewMode` discriminator rather than independent booleans such as `showHeader`, `showSubtitle`, `useTallRows`, and `showSortMenu`. A pure discriminated `FileTreeViewProfile` will derive the mode-specific rendering contract, while the same policy module exposes fixed numeric geometry by mode. Existing metadata visibility remains the single source of truth in both modes: fields checked under `Columns` in column mode become fields checked under `Details` in details mode. This avoids parallel column/detail settings and preserves the user's choices when switching modes.

Details mode removes the visual column header and metadata cells. It adds sort-key and sort-direction radio groups at the bottom of the popup because header clicks are unavailable. Column mode keeps the current header sorting and width reset action.

The highest-risk part is the virtualized layout transition. Details mode changes the visual header height from 32 px to 0 and row height from 28/36 px to 44/52 px. The virtual host, controller, scroll container, and focusable row roots therefore remain shared and long-lived. The controller snapshots scroll state before Svelte updates the DOM, treats the transition as a geometry change, remeasures the list, and restores the visible anchor or physical end. Details-only header and subtitle components isolate the presentation difference without duplicating or remounting the virtual tree.

## Problem

The Files tree currently presents metadata only as columns. This works in wide surfaces but forces a wide minimum table, horizontal scrolling, and narrow name cells in sidebars and mobile layouts. A compact two-line row is a better fit for narrow surfaces, but users still need:

- The same metadata controls.
- Sorting by any displayed field.
- Ascending and descending order.
- Stable focus, selection, expansion, and scroll position when changing the view.
- A return to the exact prior column configuration.

A naive implementation would scatter presentation booleans across the store and components. That would create invalid combinations such as a hidden header with short rows or a subtitle alongside metadata cells. The design instead models the choice as a mutually exclusive mode and derives all presentation behavior from it.

## Goals

- Add `Show details in row` as a checkable option in the existing Files popup.
- Preserve the current column view as the default.
- Render the configured metadata as a subtitle in details mode.
- Remove all visible headers, metadata columns, resize handles, and horizontal table width pressure in details mode.
- Add accessible sort-key and sort-direction controls at the bottom of the popup in details mode.
- Persist the selected view globally in browser local storage, matching the existing Files preferences.
- Preserve metadata visibility, column widths, sorting, selection, focus, expansion, and the visible scroll anchor across mode changes.
- Keep the implementation canonical for Svelte 5 and consistent with the existing Files domain ownership.
- Cover store behavior, menu behavior, row presentation, accessibility metadata, and virtual scrolling geometry with focused tests.

## Non-goals

- No server, HTTP, WebSocket, or shared file contract changes.
- No new file metadata fields.
- No automatic mode selection based on viewport width.
- No per-project or per-surface view preference.
- No independent configuration for column fields and subtitle fields.
- No change to folder-first, hidden-file, breadcrumb, filter, navigation, expansion, selection, or activation behavior.
- No redesign of the file and folder icons or copy-path action.
- No variable-height rows or wrapped subtitles.
- No live timer that continuously refreshes relative modified times.
- No new dependency.

## Resolved Product Decisions

### One explicit view mode

The store owns:

```ts
export const FILE_TREE_VIEW_MODES = ['columns', 'details'] as const;
export type FileTreeViewMode = (typeof FILE_TREE_VIEW_MODES)[number];
```

`FileTreeStore.viewMode` defaults to `columns`. Components branch on that discriminator, not a set of presentation booleans.

### One virtual host, separate presentations

The view modes do not get separate virtualizers. `FileTreeVirtualRows`, its scroll container, `FileTreeVirtualController`, `FileTreeInteractionState`, and each focusable row root survive a mode switch.

The separation occurs at the presentation boundary:

- `FileTreeViewProfile` is a discriminated union that derives all render layout and field lists from the mode.
- `FileTreeColumnHeader` remains the column presentation.
- A new `FileTreeDetailsHeader` owns the visually hidden one-column sort header.
- A new `FileTreeRowSubtitle` owns subtitle formatting, separators, accessible labels, truncation, and the empty-details fallback.
- `FileTreeRow` remains the stable interaction shell and selects only the inner metadata presentation.

Changing row and header heights changes the mapping from a physical `scrollTop` to a logical row. A second component cannot remove that transform: if destroyed, it loses scroll state and DOM focus and needs an anchor handoff to its replacement; if kept mounted, it creates two observers, two virtualizers, stale hidden geometry, duplicate accessibility trees, and two scroll positions. Geometry restoration therefore stays in the single controller that holds both the old and new layouts.

### Metadata visibility is shared

The existing size, modified, and permissions choices remain authoritative:

- In column mode, enabled fields are columns.
- In details mode, enabled fields are subtitle items.
- The menu section label changes from `Columns` to `Details` in details mode.
- Hiding the active sort field continues to reset sorting to name ascending, preserving the current invariant that the active sort key is visible.

This intentionally avoids a second set of `showSizeInSubtitle`, `showModifiedInSubtitle`, and `showPermissionsInSubtitle` settings.

### Subtitle contents

Visible subtitle values are concise and appear in canonical field order:

```text
42 KB · 3 hours ago · rw-r--r--
```

Rules:

- File size is shown only for files. Directory size remains unavailable, matching the current column behavior.
- Modified time uses the existing relative-time presentation.
- Permissions retain the existing monospace treatment.
- Unavailable individual values are omitted from the subtitle rather than rendered as ambiguous dashes.
- If none of the enabled fields has a value, the subtitle shows `No details available` so every file and folder still has a stable two-line row.
- The visible middle-dot separators are `aria-hidden`; each value includes a screen-reader-only field label.
- The subtitle is a single truncated line. It never wraps and therefore never creates variable row heights.

### Menu sorting

Details mode adds two radio groups at the bottom of the existing popup after a separator:

- `Sort by`: Name plus each currently enabled metadata field.
- `Sort direction`: Ascending or Descending.

Selecting a different sort key matches current header behavior by setting that key to ascending. Selecting the already-active key does not toggle direction; direction is controlled by its own radio group.

Sort controls appear only in details mode. Column mode keeps sorting on its headers and avoids duplicating controls in an already long menu.

### Column state survives mode changes

Switching to details mode does not modify or clear:

- `visibleColumns`
- `columnWidths`
- `sortKey`
- `sortDirection`

Switching back restores the same columns and widths. `Reset column widths` is hidden in details mode because it has no immediate visual effect, but the stored widths remain available.

### Fixed layout profiles

The two modes use fixed geometry:

| Mode | Fine-pointer row | Coarse-pointer row | Visual header | Disclosure size |
| --- | ---: | ---: | ---: | ---: |
| `columns` | 28 px | 36 px | 32 px | Same as row |
| `details` | 44 px | 52 px | 0 px | 28 px fine, 36 px coarse |

The details row is tall enough for 14 px primary text and a 12 px subtitle with a 16 px line height. The invariant is `row height = disclosure size + subtitle line height`: 28 + 16 = 44 for fine pointers and 36 + 16 = 52 for coarse pointers. This prevents clipping while preserving the current 36 px coarse disclosure target. The disclosure width is decoupled from the taller details row so indentation does not expand at every level.

### Accessibility structure

The container remains a `treegrid` in both modes. Converting details mode to a `tree` would require a second semantic model with correct virtualized `aria-posinset` and `aria-setsize` values, duplicating the established interaction contract.

Details mode has one accessible column. It renders a visually hidden header row with:

- One `columnheader`.
- The accessible name `Name and details, sorted by {field}`.
- `aria-sort="ascending"` or `aria-sort="descending"`.
- `aria-colindex="1"`.

ARIA does not require every treegrid to have a column header. The hidden header is retained for two concrete reasons: it provides the supported location for `aria-sort` after visible headers disappear, and it keeps the existing absolute row counts and indexes mode-independent. It has no visual height, so the virtualizer uses a 0 px scroll margin in details mode. The treegrid reports `aria-colcount="1"` in details mode.

The row remains the roving focus target. The single `rowheader` contains the name and subtitle. Disclosure and copy-path buttons keep their current keyboard behavior.

## Current System

### Source map

| Concern | Current owner | Relevant behavior |
| --- | --- | --- |
| File tree domain state | `web/src/lib/files/tree/file-tree.svelte.ts` | Owns sorting, optional-column visibility, widths, persistence, materialized rows, and navigation. |
| Popup content | `web/src/lib/components/files/FileTreeMenuContent.svelte` | Renders general toggles, optional-column checkboxes, and width reset. |
| Column header | `web/src/lib/components/files/FileTreeColumnHeader.svelte` | Renders headers, `aria-sort`, sort buttons, and resize handles. |
| Virtualized surface | `web/src/lib/components/files/FileTreeVirtualRows.svelte` | Owns treegrid metadata, minimum width, visual header, virtual wrappers, and row indexes. |
| Virtual geometry | `web/src/lib/components/files/FileTreeVirtualController.svelte.ts` | Assumes a 32 px header and 28/36 px rows; preserves anchors and focus across model changes. |
| Entry row | `web/src/lib/components/files/FileTreeRow.svelte` | Formats metadata and renders one rowheader plus optional metadata gridcells. |
| Synthetic rows | `FileTreeParentRow.svelte`, `FileTreeChildRow.svelte` | Fill empty gridcells to match visible columns. |
| Row dispatch | `web/src/lib/components/files/FileTreeRenderRow.svelte` | Passes grid template and visible columns to synthetic rows. |
| Persistence keys | `web/src/lib/utils/local-persistence.ts` | Defines Files preference keys. |
| Messages | `web/messages/en.json` | Defines the current Files labels and relative-time strings. |
| File metadata contract | `common/file-contracts.ts` | `FileTreeEntry` already supplies size, modified time, and permissions. |
| Store tests | `web/src/lib/files/tree/__tests__/file-tree.test.ts` | Covers preferences, visible columns, sorting, and width behavior. |
| Component tests | `web/src/lib/components/files/__tests__/*.test.ts` | Cover menu, treegrid, row behavior, column resizing, and virtualization. |

### Current state and invariants

`FileTreeStore` currently keeps sort key and direction separately:

```ts
export type SortKey = 'name' | 'size' | 'modified' | 'permissions';
export type SortDirection = 'asc' | 'desc';

sortKey = $state<SortKey>('name');
sortDirection = $state<SortDirection>('asc');
```

Optional fields are a typed record:

```ts
export type FileTreeColumnVisibility = Record<
	OptionalFileTreeColumnKey,
	boolean
>;
```

The store already derives the ordered visible columns:

```ts
get visibleColumnKeys(): FileTreeColumnKey[] {
	return FILE_TREE_COLUMN_KEYS.filter((column) => this.isColumnVisible(column));
}
```

The component-layer view profile will project this list into either column detail keys or subtitle keys. The store does not need a second presentation-specific getter.

`setColumnVisible` resets a now-hidden active sort:

```ts
if (!visible && this.sortKey === column) {
	this.setSortKey('name');
	this.setSortDirection('asc');
}
```

The new sort menu must respect this invariant and list only name plus enabled fields.

### Current virtualization assumptions

`FileTreeVirtualController` exports:

```ts
export const FILE_TREE_HEADER_HEIGHT = 32;
export const FILE_TREE_ROW_HEIGHT = 28;
export const FILE_TREE_COARSE_ROW_HEIGHT = 36;
```

The 32 px value is currently hard-coded when the controller:

- Initializes its virtual layout.
- Initializes and updates TanStack Virtual `scrollMargin`.
- Initializes and updates TanStack Virtual `scrollPaddingStart`.
- Captures an anchor.
- Restores an anchor.

Changing only the DOM header and CSS row height would leave the controller's coordinate system wrong. Mode geometry therefore has to enter the controller as one layout profile and replace every hard-coded header reference.

The controller currently distinguishes row-order changes from geometry changes. Sort and filter changes intentionally scroll to the start, while model changes normally preserve an anchor. A mode change must be treated as geometry-only:

- It must not enter `orderingModeKey`.
- It must snapshot the physical offset before DOM geometry changes.
- It must capture and restore the current anchor, or preserve the physical end when already there.
- It must force the virtualizer to measure.
- It must not reconcile focus as if rows were inserted or removed.

### Current accessibility assumptions

The treegrid currently includes the visible header in `aria-rowcount` and gives entry rows indexes starting at 2. It reports one accessible column per visible visual column. Entry names use `rowheader`; metadata uses `gridcell`.

Details mode will preserve a header row semantically while making it visually hidden. The header is not required merely because the row count is virtualized; it is retained to expose `aria-sort` and avoid a mode-dependent off-by-one contract.

## Research

### Svelte 5

The repository resolves Svelte `5.56.6` in `bun.lock`.

The design follows the official Svelte 5 guidance:

- [`$state` class fields](https://svelte.dev/docs/svelte/%24state#Classes) are the canonical way to keep reactive domain state in a class.
- [`$state.raw`](https://svelte.dev/docs/svelte/%24state#%24state.raw) remains appropriate for the existing visibility and width objects because the store replaces them rather than mutating them.
- [`$derived`](https://svelte.dev/docs/svelte/%24derived) is appropriate for mode-derived presentation data.
- [`$effect`](https://svelte.dev/docs/svelte/%24effect) is not needed to synchronize view mode into header visibility, row height, or menu visibility. Those are direct derivations.
- [`$effect.pre`](https://svelte.dev/docs/svelte/%24effect#%24effect.pre) runs before Svelte updates the DOM and is the correct place to snapshot the scroll offset that belongs to the old geometry.

The mode change will not use a keyed block. Existing virtual row instances, focus, and nested directory state must survive the presentation switch.

### WAI-ARIA treegrid

The [WAI-ARIA Treegrid Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treegrid/) requires rows to contain `columnheader`, `rowheader`, or `gridcell` cells and recommends `aria-sort` on the active sortable header. The [Grid and Table Properties guidance](https://www.w3.org/WAI/ARIA/apg/practices/grid-and-table-properties/) requires virtualized row counts and indexes to describe the complete logical grid; any header row that exists is included in those counts and positions.

The hidden one-column header in details mode satisfies those constraints while removing all visual columns.

### Existing dependencies

The existing dropdown wrapper already exports `DropdownMenuRadioGroup` and `DropdownMenuRadioItem`, backed by Bits UI. The Git worktree picker uses the same components for sort choices in `web/src/lib/components/git/GitWorktreePickerModal.svelte`. No new menu primitive or dependency is required.

The [Bits UI Dropdown Menu API](https://bits-ui.com/docs/components/dropdown-menu) documents `closeOnSelect` on checkbox and radio items and defaults it to `true`. The mode checkbox and details-mode sort radio items will set it to `false`: checking the mode can reveal its options in place, and users can set key and direction without reopening the menu. The shared dropdown content already caps itself to the available viewport height and scrolls vertically.

## Proposed Architecture

### Store owns preference and domain intent

`FileTreeStore` owns `viewMode`, persistence, metadata visibility, and sort transitions. It does not own view profiles, pixel geometry, localized labels, subtitle lists, or rendered grid templates.

Add to `web/src/lib/files/tree/file-tree.svelte.ts`:

```ts
export const FILE_TREE_VIEW_MODES = ['columns', 'details'] as const;
export type FileTreeViewMode = (typeof FILE_TREE_VIEW_MODES)[number];

function isFileTreeViewMode(value: string | null): value is FileTreeViewMode {
	return value !== null && FILE_TREE_VIEW_MODES.includes(value as FileTreeViewMode);
}

function isSortKey(value: string): value is SortKey {
	return FILE_TREE_COLUMN_KEYS.includes(value as FileTreeColumnKey);
}

export class FileTreeStore {
	viewMode = $state<FileTreeViewMode>('columns');

	setViewMode(mode: FileTreeViewMode): void {
		if (mode === this.viewMode) return;
		this.viewMode = mode;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeViewMode, mode);
	}

	setShowDetailsInRow(show: boolean): void {
		this.setViewMode(show ? 'details' : 'columns');
	}

	selectSortKey(value: string): void {
		if (!isSortKey(value) || !this.isColumnVisible(value)) return;
		if (value === this.sortKey) return;
		this.setSort(value, 'asc');
	}

	setSort(key: SortKey, direction: SortDirection): void {
		this.sortKey = key;
		this.sortDirection = direction;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeSortKey, key);
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeSortDirection, direction);
	}

	toggleSort(key: SortKey): void {
		this.setSort(
			key,
			this.sortKey === key && this.sortDirection === 'asc' ? 'desc' : 'asc',
		);
	}
}
```

`setShowDetailsInRow` is an intention-revealing adapter for the checkbox. It is not stored as another boolean.

`setSort` makes a sort transition atomic from the caller's perspective and prevents the header and popup paths from drifting. `setSortDirection` remains for the direction radio group. The implementation removes `setSortKey`; its production callers are replaced by `setSort`, and the direct store test is updated. `SortKey` becomes an alias of `FileTreeColumnKey`, and the same guard validates persisted and menu values:

```ts
export type SortKey = FileTreeColumnKey;
```

Load the preference in `#loadPreferences`:

```ts
const viewMode = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeViewMode);
if (isFileTreeViewMode(viewMode)) this.viewMode = viewMode;
```

Add the key in `web/src/lib/utils/local-persistence.ts`:

```ts
fileTreeViewMode: 'file-tree-view-mode',
```

This preference is new, so no migration is required. Missing or malformed values fall back to `columns`.

### One view profile derives the rendering contract

Create `web/src/lib/components/files/file-tree-view-profile.ts`. This pure component-layer module is the only place that translates the domain mode into layout choices:

```ts
export interface FileTreeViewGeometry {
	headerHeight: number;
	fineRowHeight: number;
	coarseRowHeight: number;
	fineDisclosureSize: number;
	coarseDisclosureSize: number;
}

interface FileTreeViewProfileBase {
	gridTemplate: string;
	fillerColumnKeys: readonly OptionalFileTreeColumnKey[];
	accessibleColumnCount: number;
	minimumTableWidth: string;
}

export type FileTreeViewProfile =
	| (FileTreeViewProfileBase & {
			mode: 'columns';
			columnDetailKeys: readonly OptionalFileTreeColumnKey[];
	  })
	| (FileTreeViewProfileBase & {
			mode: 'details';
			subtitleKeys: readonly OptionalFileTreeColumnKey[];
	  });

interface CreateFileTreeViewProfileOptions {
	mode: FileTreeViewMode;
	visibleColumnKeys: readonly FileTreeColumnKey[];
	columnGridTemplate: string;
}

const FILE_TREE_VIEW_GEOMETRY: Readonly<
	Record<FileTreeViewMode, FileTreeViewGeometry>
> = {
	columns: {
		headerHeight: 32,
		fineRowHeight: 28,
		coarseRowHeight: 36,
		fineDisclosureSize: 28,
		coarseDisclosureSize: 36,
	},
	details: {
		headerHeight: 0,
		fineRowHeight: 44,
		coarseRowHeight: 52,
		fineDisclosureSize: 28,
		coarseDisclosureSize: 36,
	},
};

export const FILE_TREE_HEADER_HEIGHT =
	FILE_TREE_VIEW_GEOMETRY.columns.headerHeight;
export const FILE_TREE_ROW_HEIGHT =
	FILE_TREE_VIEW_GEOMETRY.columns.fineRowHeight;
export const FILE_TREE_COARSE_ROW_HEIGHT =
	FILE_TREE_VIEW_GEOMETRY.columns.coarseRowHeight;

export function fileTreeViewGeometry(
	mode: FileTreeViewMode,
): FileTreeViewGeometry {
	return FILE_TREE_VIEW_GEOMETRY[mode];
}

export function createFileTreeViewProfile(
	options: CreateFileTreeViewProfileOptions,
): FileTreeViewProfile {
	const detailKeys = options.visibleColumnKeys.filter(
		(key): key is OptionalFileTreeColumnKey => key !== 'name',
	);

	if (options.mode === 'details') {
		return {
			mode: 'details',
			gridTemplate: 'minmax(0, 1fr)',
			fillerColumnKeys: [],
			subtitleKeys: detailKeys,
			accessibleColumnCount: 1,
			minimumTableWidth: '240px',
		};
	}

	return {
		mode: 'columns',
		gridTemplate: options.columnGridTemplate,
		fillerColumnKeys: detailKeys,
		columnDetailKeys: detailKeys,
		accessibleColumnCount: options.visibleColumnKeys.length,
		minimumTableWidth:
			options.visibleColumnKeys.length === 1 ? '240px' : '520px',
	};
}
```

The discriminated union makes invalid combinations unrepresentable: a column profile cannot carry subtitle keys, and a details profile cannot carry metadata-cell keys. Components receive the profile or narrow values from it instead of independently deriving `detailsMode`, column counts, grid templates, filler cells, or widths.

Geometry is selected separately so dragging a column width does not make the virtual controller rerun merely because the larger profile object changed identity. Both outputs still come from the same pure policy module and the same mode discriminator. The controller receives only numeric geometry through a getter-backed option; it never imports `FileTreeViewMode` or knows what a subtitle is.

### Component layer owns labels and formatting

Create `web/src/lib/components/files/file-tree-entry-presentation.ts`. This prevents column cells, subtitles, hidden headers, and menu items from growing separate field-label and formatting switches.

```ts
import type { FileTreeEntry } from '$shared/file-contracts';
import type {
	FileTreeColumnKey,
	OptionalFileTreeColumnKey,
} from '$lib/files/tree/file-tree.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export interface FileTreeDetailPresentation {
	key: OptionalFileTreeColumnKey;
	value: string | null;
	monospace: boolean;
}

const fieldLabels: Record<FileTreeColumnKey, () => string> = {
	name: m.filetree_name,
	size: m.filetree_size,
	modified: m.filetree_modified,
	permissions: m.filetree_permissions,
};

export function fileTreeFieldLabel(key: FileTreeColumnKey): string {
	return fieldLabels[key]();
}

export function formatFileTreeSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const unitIndex = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** unitIndex;
	return `${Number(value.toFixed(1))} ${units[unitIndex]}`;
}

export function formatFileTreeModified(
	value: string | null,
	now = Date.now(),
): string | null {
	if (!value) return null;
	const timestamp = new Date(value).getTime();
	if (!Number.isFinite(timestamp)) return null;
	let remaining = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (remaining < 60) return m.filetree_just_now();
	remaining = Math.floor(remaining / 60);
	if (remaining < 60) return m.filetree_min_ago({ count: remaining });
	remaining = Math.floor(remaining / 60);
	if (remaining < 24) return m.filetree_hours_ago({ count: remaining });
	remaining = Math.floor(remaining / 24);
	if (remaining < 30) return m.filetree_days_ago({ count: remaining });
	return new Date(timestamp).toLocaleDateString();
}

export function presentFileTreeDetail(
	entry: FileTreeEntry,
	key: OptionalFileTreeColumnKey,
	now = Date.now(),
): FileTreeDetailPresentation {
	switch (key) {
		case 'size':
			return {
				key,
				value: entry.type === 'file' ? formatFileTreeSize(entry.size) : null,
				monospace: false,
			};
		case 'modified':
			return {
				key,
				value: formatFileTreeModified(entry.modified, now),
				monospace: false,
			};
		case 'permissions':
			return {
				key,
				value: entry.permissionsRwx || null,
				monospace: true,
			};
	}
}
```

The exact helper may return an additional tooltip if implementation discovery finds a useful existing absolute-time formatter. It must not add a timer or effect.

### Menu derives its sections from view mode

Update `web/src/lib/components/files/FileTreeMenuContent.svelte` to import the existing radio components plus `ArrowUpDown` and `Rows3` from Lucide.

The relevant structure is:

```svelte
<DropdownMenuCheckboxItem
	checked={store.viewMode === 'details'}
	closeOnSelect={false}
	onCheckedChange={(checked) => store.setShowDetailsInRow(Boolean(checked))}
>
	{m.filetree_show_details_in_row()}
</DropdownMenuCheckboxItem>

<DropdownMenuSeparator />
<DropdownMenuLabel class="flex items-center gap-2 text-xs text-muted-foreground">
	{#if store.viewMode === 'details'}
		<Rows3 class="h-3.5 w-3.5" />
		{m.filetree_details()}
	{:else}
		<Columns3 class="h-3.5 w-3.5" />
		{m.filetree_columns()}
	{/if}
</DropdownMenuLabel>

<DropdownMenuCheckboxItem
	checked={store.visibleColumns.size}
	onCheckedChange={(checked) => store.setColumnVisible('size', Boolean(checked))}
>
	{m.filetree_size()}
</DropdownMenuCheckboxItem>

<!-- Modified and Permissions remain the same. -->

{#if store.viewMode === 'columns'}
	<DropdownMenuSeparator />
	<DropdownMenuItem onclick={() => store.resetColumnWidths()}>
		<RotateCcw class="h-4 w-4" />
		{m.filetree_reset_column_widths()}
	</DropdownMenuItem>
{:else}
	<DropdownMenuSeparator />
	<DropdownMenuLabel class="flex items-center gap-2 text-xs text-muted-foreground">
		<ArrowUpDown class="h-3.5 w-3.5" />
		{m.filetree_sort_by()}
	</DropdownMenuLabel>
	<DropdownMenuRadioGroup
		value={store.sortKey}
		onValueChange={(value) => store.selectSortKey(value)}
	>
		{#each store.visibleColumnKeys as key (key)}
			<DropdownMenuRadioItem value={key} closeOnSelect={false}>
				{fileTreeFieldLabel(key)}
			</DropdownMenuRadioItem>
		{/each}
	</DropdownMenuRadioGroup>

	<DropdownMenuLabel class="text-xs text-muted-foreground">
		{m.filetree_sort_direction()}
	</DropdownMenuLabel>
	<DropdownMenuRadioGroup
		value={store.sortDirection}
		onValueChange={(value) => {
			if (value === 'asc' || value === 'desc') store.setSortDirection(value);
		}}
	>
		<DropdownMenuRadioItem value="asc" closeOnSelect={false}>
			{m.filetree_sort_ascending()}
		</DropdownMenuRadioItem>
		<DropdownMenuRadioItem value="desc" closeOnSelect={false}>
			{m.filetree_sort_descending()}
		</DropdownMenuRadioItem>
	</DropdownMenuRadioGroup>
{/if}
```

The complete menu order is:

1. Responsive overflow actions, when present.
2. Folders first.
3. Show hidden files.
4. Show breadcrumbs.
5. Show details in row.
6. Columns or Details field controls.
7. Column width reset in column mode, or sorting controls in details mode.

No submenu is necessary. Direct radio items make the selected state visible and keyboard-accessible without introducing another navigation layer on mobile. The mode checkbox and sort radios keep the popup open. The existing field checkboxes retain their current close behavior.

### Row shell remains stable while subtitle presentation is separate

`FileTreeRow.svelte` remains the interaction shell. It owns one focusable `role="row"` root in both modes, including the row key, `tabindex`, selection and expansion ARIA, focus and activation handlers, disclosure, icon, name, copy-path action, and indent guides. A mode switch never replaces this root.

Create `FileTreeRowSubtitle.svelte` with value props:

```svelte
<script lang="ts">
	import type { FileTreeEntry } from '$shared/file-contracts';
	import type { OptionalFileTreeColumnKey } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import {
		fileTreeFieldLabel,
		presentFileTreeDetail,
		type FileTreeDetailPresentation,
	} from './file-tree-entry-presentation.js';

	let {
		entry,
		keys,
	}: {
		entry: FileTreeEntry;
		keys: readonly OptionalFileTreeColumnKey[];
	} = $props();

	const availableDetails = $derived(
		keys
			.map((key) => presentFileTreeDetail(entry, key))
			.filter(
				(detail): detail is FileTreeDetailPresentation & { value: string } =>
					detail.value !== null,
			),
	);
	const subtitleTitle = $derived(
		availableDetails
			.map((detail) => `${fileTreeFieldLabel(detail.key)}: ${detail.value}`)
			.join(' · '),
	);
</script>

<div
	class="flex min-w-0 items-center overflow-hidden whitespace-nowrap pl-[calc(var(--file-tree-disclosure-size)+1.5rem)] text-xs leading-4 text-muted-foreground"
	data-file-tree-subtitle
	title={subtitleTitle || m.filetree_no_details_available()}
>
	{#if availableDetails.length === 0}
		<span class="truncate">{m.filetree_no_details_available()}</span>
	{:else}
		{#each availableDetails as detail, index (detail.key)}
			{#if index > 0}
				<span class="mx-1 shrink-0" aria-hidden="true">·</span>
			{/if}
			<span class:font-mono={detail.monospace} class="truncate">
				<span class="sr-only">{fileTreeFieldLabel(detail.key)}: </span>
				{detail.value}
			</span>
		{/each}
	{/if}
</div>
```

`FileTreeRow` receives `profile: FileTreeViewProfile`. Its root uses `profile.gridTemplate`; only the inner metadata presentation branches:

```svelte
<div
	role="row"
	...
	style={`grid-template-columns: ${profile.gridTemplate}`}
>
	<div
		role="rowheader"
		class="relative min-w-0 overflow-hidden"
		style={`padding-left: ${(row.level - 1) * 16}px`}
		title={entry.path}
	>
		<div class="flex min-w-0 items-center">
			<!-- Existing disclosure, icon, name, and copy-path content. -->
		</div>

		{#if profile.mode === 'details'}
			<FileTreeRowSubtitle {entry} keys={profile.subtitleKeys} />
		{/if}
	</div>

	{#if profile.mode === 'columns'}
		{#each profile.columnDetailKeys as key (key)}
			{@const detail = presentFileTreeDetail(entry, key)}
			<div
				role="gridcell"
				class:font-mono={detail.monospace}
				class="truncate whitespace-nowrap text-muted-foreground"
				title={detail.value ?? '-'}
			>
				{detail.value ?? '-'}
			</div>
		{/each}
	{/if}
</div>
```

The discriminator creates two exhaustive inner presentations without separate focusable row components or complementary booleans. Extracting the subtitle is justified because it owns nontrivial formatting, missing-value, tooltip, separator, and accessibility behavior. Extracting the small column cell loop would add indirection without a separate responsibility.

The final subtitle spacing must be validated visually rather than copying the example's exact padding if it does not align under the name. It remains expressed through stable disclosure and icon tracks, not a viewport-dependent font size.

`FileTreeRenderRow.svelte` receives the profile and passes it to entry rows. For parent, loading, and error rows, it passes only `profile.gridTemplate` and the already-sliced `profile.fillerColumnKeys`. Rename the leaf prop from `visibleColumnKeys` to `fillerColumnKeys` and iterate it directly. The list is empty in details mode, so no synthetic metadata cells render. No leaf component receives `viewMode`, and no leaf duplicates mode policy. Synthetic rows use the active row height for virtual consistency but do not invent subtitles.

### Virtual rows render a hidden semantic header

`FileTreeVirtualRows.svelte` creates the one profile:

```ts
let profile = $derived(
	createFileTreeViewProfile({
		mode: store.viewMode,
		visibleColumnKeys: store.visibleColumnKeys,
		columnGridTemplate: store.columnGridTemplate,
	}),
);
let geometry = $derived(fileTreeViewGeometry(store.viewMode));
let tableMinimumWidth = $derived(
	presentation === 'mobile'
		? `min(${profile.minimumTableWidth}, 100%)`
		: profile.minimumTableWidth,
);
```

The treegrid uses `profile.accessibleColumnCount`, and every rendered row receives `profile`.

Create `FileTreeDetailsHeader.svelte` to own the details-specific semantic header. It accepts `sortKey`, `sortDirection`, and `ariaRowIndex` as values rather than importing the store:

```svelte
<div role="row" aria-rowindex={ariaRowIndex} class="sr-only">
	<div
		role="columnheader"
		aria-colindex="1"
		aria-sort={sortDirection === 'asc' ? 'ascending' : 'descending'}
	>
		{m.filetree_name_and_details_sorted({
			field: fileTreeFieldLabel(sortKey),
		})}
	</div>
</div>
```

The host selects the header presentation:

```svelte
{#if profile.mode === 'columns'}
	<FileTreeColumnHeader {store} ariaRowIndex={1} />
{:else}
	<FileTreeDetailsHeader
		sortKey={store.sortKey}
		sortDirection={store.sortDirection}
		ariaRowIndex={1}
	/>
{/if}
```

The hidden row means these existing values do not branch by mode:

```svelte
aria-rowcount={model.rows.length + 1}
ariaRowIndex={virtualItem.index + 2}
```

The boundary fallback uses `profile.gridTemplate` so an invalid row cannot reintroduce width inconsistencies. Correcting the fallback's existing incomplete cell semantics in multi-column mode is outside this feature's scope.

### Virtual controller consumes a geometry profile

Add a getter-backed numeric input to `FileTreeVirtualControllerOptions`:

```ts
interface FileTreeVirtualControllerOptions {
	get model(): FileTreeRenderModel;
	get orderingModeKey(): string;
	get viewport(): HTMLElement | null;
	get store(): FileTreeStore;
	get geometry(): FileTreeViewGeometry;
	activateEntry(row: FileTableRow): void;
}
```

The host supplies it without duplicating mode state:

```ts
const controller = new FileTreeVirtualController({
	// Existing getters remain.
	get geometry() {
		return geometry;
	},
});
```

The controller consumes only geometry:

```ts
get headerHeight(): number {
	return this.options.geometry.headerHeight;
}

get rowHeight(): number {
	return this.coarsePointer
		? this.options.geometry.coarseRowHeight
		: this.options.geometry.fineRowHeight;
}

get disclosureSize(): number {
	return this.coarsePointer
		? this.options.geometry.coarseDisclosureSize
		: this.options.geometry.fineDisclosureSize;
}
```

The controller does not import the mode discriminator or view profile factory. Its three existing exported column constants must remain because current virtual-row tests import them. Define them once from the column geometry in the policy module and re-export them from the controller for compatibility; do not repeat their pixel literals. Every virtualizer option and coordinate calculation uses the active `headerHeight` or `layout.scrollMargin`, not the compatibility aliases.

The persisted details mode must be correct on its first frame. A Svelte rune must remain in a class field, while that field cannot read a constructor parameter property before the constructor body assigns it. Keep a neutral reactive construction value, then replace it from the supplied geometry before creating the virtualizer or installing effects:

```ts
#virtualLayout = $state.raw<FileTreeVirtualLayout>(
	createFileTreeVirtualLayout({
		rowCount: 0,
		rowHeight: 1,
		viewportHeight: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT,
		scrollMargin: 0,
	}),
);
#previousGeometryKey = '';
#pendingGeometryScrollSnapshot: {
	element: HTMLElement;
	offset: number;
	geometryKey: string;
} | null = null;

constructor(private readonly options: FileTreeVirtualControllerOptions) {
	const geometry = options.geometry;
	this.#virtualLayout = createFileTreeVirtualLayout({
		rowCount: 0,
		rowHeight: geometry.fineRowHeight,
		viewportHeight: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT,
		scrollMargin: geometry.headerHeight,
	});
	this.#previousGeometryKey =
		`${geometry.headerHeight}:${geometry.fineRowHeight}`;

	// Existing interaction, virtualizer construction, and effects follow.
}
```

No observer can see the neutral value before construction completes. The initial `createVirtualizer` options use the assigned layout's `scrollMargin`, avoiding a persisted details view with a column header margin until the first effect.

The view-mode template branch and CSS custom properties update during Svelte's DOM flush. A normal `$effect` would read `scrollTop` after the geometry changed. In particular, details-to-columns reduces the physical maximum and can clamp the old offset; browser scroll anchoring can also shift either transition. That post-change value cannot be interpreted in the old coordinate system. Extend the controller's existing `$effect.pre` to snapshot geometry-driven offsets before DOM updates:

```ts
get #geometryKey(): string {
	return `${this.headerHeight}:${this.rowHeight}`;
}

$effect.pre(() => {
	const nextGeometryKey = this.#geometryKey;
	const viewport = this.options.viewport;
	if (
		viewport &&
		this.#previousGeometryKey !== nextGeometryKey
	) {
		this.#pendingGeometryScrollSnapshot = {
			element: viewport,
			offset: viewport.scrollTop,
			geometryKey: nextGeometryKey,
		};
	}

	// Existing pre-update DOM-focus snapshot remains in this same effect.
});
```

The existing model-focus branch must no longer return from the whole pre-effect before this geometry block runs. Its `oldModel` and model-identity guards apply only to the focus snapshot.

Set `overflow-anchor: none` on the Files viewport so the controller, rather than browser heuristics, owns scroll restoration:

```css
.file-tree-virtual-grid {
	overflow-anchor: none;
}
```

The update path adds explicit geometry detection:

```ts
const nextLayout = createFileTreeVirtualLayout({
	rowCount: nextModel.rows.length,
	rowHeight: this.rowHeight,
	viewportHeight: this.viewportHeight,
	scrollMargin: this.headerHeight,
});
const geometryChanged =
	oldModel !== null &&
	(oldLayout.rowHeight !== nextLayout.rowHeight ||
		oldLayout.scrollMargin !== nextLayout.scrollMargin);
const geometrySnapshot = this.#pendingGeometryScrollSnapshot;
const capturedPhysicalScrollOffset =
	geometryChanged &&
	geometrySnapshot?.element === scrollElement &&
	geometrySnapshot.geometryKey === this.#geometryKey
		? geometrySnapshot.offset
		: (scrollElement?.scrollTop ?? 0);
const layoutGenerationChanged =
	modelChanged ||
	orderingChanged ||
	geometryChanged ||
	viewportChanged ||
	scrollElementChanged;
```

This geometry comparison replaces `coarsePointerChanged`. Delete `#previousCoarsePointer`, the local flag, and its assignment. Comparing the logical `rowHeight`, rather than compressed `layoutRowHeight`, still detects pointer and mode changes after very large lists enter compressed layout.

Physical-end preservation expands to geometry changes:

```ts
const wasAtPhysicalEnd =
	Math.abs(capturedPhysicalScrollOffset - oldPhysicalMaximum) <= 0.5;
const preservePhysicalEnd =
	oldModel !== null &&
	(((viewportChanged || geometryChanged) && wasAtPhysicalEnd) ||
		(viewportChanged &&
			!geometryChanged &&
			nextPhysicalMaximum < oldPhysicalMaximum &&
			capturedPhysicalScrollOffset >= nextPhysicalMaximum - 0.5));
```

Being at the end is a stronger user signal than retaining the first visible anchor. A mode or pointer geometry change preserves the end when the pre-update snapshot was at the end; otherwise it preserves the anchor.

The fallback that recognizes a browser-clamped end remains limited to viewport-only changes. Comparing an old physical offset with a new maximum is invalid when the row height changes because those values use different coordinate scales. Including exact old-end detection for every geometry change still improves the existing coarse-pointer transition at the physical end in column mode without misclassifying a deep details-mode anchor as the column-mode end.

Anchor capture includes geometry changes:

```ts
const anchor =
	oldModel &&
	scrollElement &&
	(modelChanged || geometryChanged || viewportChanged) &&
	!orderingChanged &&
	!preservePhysicalEnd &&
	!this.#explicitFocusRequestPending
		? captureFileTreeVirtualAnchor(
				oldModel.rows,
				this.#logicalVirtualItems(oldLayout),
				fileTreePhysicalToLogicalOffset(
					oldLayout,
					capturedPhysicalScrollOffset,
				),
				oldLayout.scrollMargin,
			)
		: null;
```

The virtualizer remeasures on geometry change:

```ts
if (modelChanged || geometryChanged) {
	virtualizer.measure();
	virtualizer.getVirtualItems();
}
```

At the end of every update, next to the existing previous-model and previous-ordering assignments, the update path unconditionally clears `#pendingGeometryScrollSnapshot` and records `#previousGeometryKey = this.#geometryKey`. This prevents a cold-mount or otherwise unused snapshot from leaking into a later generation. Anchor restoration and keyboard scroll calculations use `this.#virtualLayout.scrollMargin`. The mode must not be appended to `orderingModeKey`; doing so would incorrectly scroll to the top.

The committed header can temporarily shrink the browser's scrollable height before the virtual body's new height reaches the DOM. Before deferring restoration to an animation frame, the controller waits for Svelte's DOM commit, reads `scrollHeight` to force the new geometry through layout, and captures the resulting exact `scrollTop` before the browser can deliver another user-input task. This handles engines that clamp eagerly and engines that defer clamping until layout. Deferred restoration compares against that committed-layout baseline without widening the existing 0.5 px guard, so an automatic clamp is accepted while a later user scroll still cancels restoration.

`FileTreeVirtualRows.svelte` publishes both CSS dimensions:

```svelte
style:--file-tree-row-height={`${controller.rowHeight}px`}
style:--file-tree-disclosure-size={`${controller.disclosureSize}px`}
```

## Messages

Add these keys to `web/messages/en.json`:

```json
{
	"filetree_details": "Details",
	"filetree_name_and_details_sorted": "Name and details, sorted by {field}",
	"filetree_no_details_available": "No details available",
	"filetree_show_details_in_row": "Show details in row",
	"filetree_sort_ascending": "Ascending",
	"filetree_sort_by": "Sort by",
	"filetree_sort_descending": "Descending",
	"filetree_sort_direction": "Sort direction"
}
```

Regenerate Paraglide from the repository root:

```sh
cd web && bunx @inlang/paraglide-js compile \
	--project ./project.inlang \
	--outdir ./src/lib/paraglide
```

Generated message files are not manually edited.

## Data, API, and Migration

### Data model

No file entry shape changes. The current contract already provides:

```ts
export interface FileTreeEntry {
	name: string;
	path: string;
	relativePath: string;
	type: 'file' | 'directory';
	size: number;
	modified: string | null;
	permissionsRwx: string;
}
```

### API and protocol

No HTTP, WebSocket, sender, receiver, parser, or shared-contract changes are required.

### Persistence

One new local-storage value is added:

```text
file-tree-view-mode = "columns" | "details"
```

It is global, matching existing Files preferences. Invalid values are ignored. Existing users default to column mode, so rollout preserves current behavior.

There is no durable data migration and no rollback migration. Removing the feature later can ignore the orphaned local-storage value safely.

## Failure Modes and Edge Cases

### Mode switch while scrolled

Risk: taller rows and a removed visual header can move the user's visible files or clamp the physical scroll offset.

Mitigation: the existing `$effect.pre` captures physical `scrollTop` before the DOM changes, and `overflow-anchor: none` prevents browser heuristics from competing with the controller. The controller maps the existing logical anchor through the old and new layouts after remeasurement. If the captured offset was at the physical end, the geometry-aware end-preservation path takes precedence.

### Mode switch while a row has focus

Risk: conditional markup can drop DOM focus or remount the active row.

Mitigation: keep the same root row element and key. Change only its internal presentation. The virtual controller does not treat the mode as an ordering change.

### Mode switch during an explicit virtual focus transfer

Risk: automatic anchor restoration can race Home/End or arrow navigation.

Mitigation: retain the existing `#explicitFocusRequestPending` guard. Geometry-driven restoration uses the same token checks as model-driven restoration.

### Missing or invalid metadata

Risk: subtitles such as `- · -` are unclear and can collapse unexpectedly.

Mitigation: omit unavailable individual values and render `No details available` when the result is empty. Column mode retains its existing dash fallback.

### All optional fields hidden

The details row shows `No details available`, the sort-key list contains only Name, and any active hidden sort has already reset to name ascending.

### Deeply nested paths

Risk: tying disclosure width to a 44/52 px row would consume too much horizontal space per level.

Mitigation: use the existing 16 px level indent and a separate disclosure-size metric.

### Very large directories

The virtual row count and compressed layout remain unchanged. A 44/52 px logical height may enter compressed mode at a smaller row count, which `createFileTreeVirtualLayout` already supports.

### Cold load in persisted details mode

Risk: initializing the controller from column constants creates one incorrect header margin and row estimate before the first reactive update.

Mitigation: construct the initial virtual layout and TanStack options from the getter-backed view geometry. Details mode therefore starts with a 0 px scroll margin and 44 px fine-pointer estimate on its first frame.

### Narrow and mobile surfaces

Details mode uses a 240 px base minimum and caps it at 100% on mobile. Subtitle and name both truncate. No font size scales with viewport width.

### Column-mode restoration

Column widths are never reset or normalized when entering details mode. Returning to columns restores the prior template exactly.

### Malformed local storage

Only the two recognized string values are accepted. The default remains `columns`.

## Performance

- No additional API request or background work.
- No new effect; the existing `$effect.pre` also captures geometry transitions.
- Detail presentations are derived only for mounted virtual rows.
- Subtitle rendering adds a bounded maximum of three small spans per mounted row.
- The logical row model does not rebuild when view mode changes.
- The virtualizer remeasures only on mode or pointer-geometry changes, not during scroll.
- The existing 100,000-row bounded-window test remains the primary regression guard.

## Security and Privacy

The change exposes only metadata already returned to and displayed by the client. It does not add paths, content, permissions, or timestamps to logs or network payloads. Local storage contains only the view mode, not file data.

## Compatibility

- Current users remain in column mode after upgrade.
- Desktop, sidebar, portable, and mobile Files surfaces share the same root-owned `FileTreeStore`, so the preference stays coherent across projections.
- The design uses existing Svelte 5, Bits UI, TanStack Virtual, Lucide, Tailwind, and Paraglide capabilities.
- No backward server/client protocol compatibility is relevant.

## Implementation Plan

### Add the typed mode and persistence

Files:

- `web/src/lib/files/tree/file-tree.svelte.ts`
- `web/src/lib/utils/local-persistence.ts`
- `web/src/lib/files/tree/__tests__/file-tree.test.ts`

Work:

- Add `FileTreeViewMode`.
- Add `viewMode`, `setViewMode`, and `setShowDetailsInRow`.
- Load and persist the new value.
- Consolidate sort transitions enough that the column header and menu cannot disagree.
- Preserve the hidden-active-sort invariant.

Tests:

- Defaults to `columns`.
- Loads `details`.
- Persists both transitions.
- Ignores malformed values.
- Selecting a different visible sort key sets ascending.
- Rejects a hidden or invalid menu sort key.

Validation:

```sh
bun run --cwd web test -- src/lib/files/tree/__tests__/file-tree.test.ts
```

Rollback: remove the new field and key. Existing behavior is the default path.

### Derive one discriminated view profile

Files:

- New `web/src/lib/components/files/file-tree-view-profile.ts`
- New `web/src/lib/components/files/__tests__/file-tree-view-profile.logic.test.ts`

Work:

- Translate mode, visible columns, and the column grid template into one exhaustive profile.
- Keep column-only and details-only fields on distinct union members.
- Include accessible column count, minimum width, and synthetic filler keys in the profile.
- Expose fixed numeric geometry from the same pure mode-policy module.
- Keep mode and pixel policy out of leaf row components and the virtual controller.

Tests:

- Column mode preserves the supplied grid template, visible detail keys, filler keys, and current width thresholds.
- Details mode produces one grid track, no filler cells, enabled subtitle keys in canonical order, one accessible column, and a 240 px minimum.
- Fine and coarse geometry matches both fixed profiles.
- The return type narrows column-only and details-only fields by `mode`.

Validation:

```sh
bun run --cwd web test -- \
	src/lib/components/files/__tests__/file-tree-view-profile.logic.test.ts
```

Rollback: inline the same profile derivation in the virtual host; no domain or persistence state changes.

### Centralize file detail presentation

Files:

- New `web/src/lib/components/files/file-tree-entry-presentation.ts`
- New `web/src/lib/components/files/__tests__/file-tree-entry-presentation.logic.test.ts`
- `web/src/lib/components/files/FileTreeColumnHeader.svelte`

Work:

- Move field labels and metadata formatting into the pure presentation helper.
- Reuse `fileTreeFieldLabel` in the column header.
- Keep invalid/missing metadata explicit as `null`.

Representative tests:

```ts
it('omits directory size and unavailable metadata', () => {
	const directory = entry('src', 'directory', {
		modified: null,
		permissionsRwx: '',
	});

	expect(presentFileTreeDetail(directory, 'size').value).toBeNull();
	expect(presentFileTreeDetail(directory, 'modified', NOW).value).toBeNull();
	expect(presentFileTreeDetail(directory, 'permissions').value).toBeNull();
});

it('formats file details deterministically', () => {
	const file = entry('README.md', 'file', {
		size: 1_536,
		modified: '2026-07-31T10:00:00.000Z',
		permissionsRwx: 'rw-r--r--',
	});

	expect(presentFileTreeDetail(file, 'size').value).toBe('1.5 KB');
	expect(
		presentFileTreeDetail(file, 'modified', Date.parse('2026-07-31T12:00:00.000Z'))
			.value,
	).toBe('2 hours ago');
	expect(presentFileTreeDetail(file, 'permissions').monospace).toBe(true);
});
```

Validation:

```sh
bun run --cwd web test -- \
	src/lib/components/files/__tests__/file-tree-entry-presentation.logic.test.ts
```

Rollback: restore the component-local formatting functions.

### Add menu controls and messages

Files:

- `web/src/lib/components/files/FileTreeMenuContent.svelte`
- `web/src/lib/components/files/__tests__/FileTree.test.ts`
- `web/src/lib/components/files/__tests__/FileTreeToolbar.test.ts`
- `web/messages/en.json`
- Generated `web/src/lib/paraglide/**`

Work:

- Add the mode checkbox.
- Relabel the field section by mode.
- Render width reset only in column mode.
- Render sort key and direction radio groups only in details mode.
- Regenerate messages.

Component assertions:

- `Show details in row` is an unchecked `menuitemcheckbox` by default.
- Checking it updates `store.viewMode` and its persisted value.
- Checking it keeps the popup open and reveals the details controls in place.
- Details mode shows `Details`, hides `Reset column widths`, and exposes both radio groups.
- Sort key items are Name plus enabled fields.
- The current key and direction report `aria-checked="true"`.
- Selecting Modified changes order and defaults direction to ascending.
- Selecting Modified and then Descending does not require reopening the popup.
- Returning to columns restores `Columns` and `Reset column widths` and removes popup sort controls.
- Responsive overflow actions remain before the view controls with one separator.
- Every sort item is present as a `menuitemradio` and remains keyboard-reachable.

Validation:

```sh
bun run --cwd web test -- \
	src/lib/components/files/__tests__/FileTree.test.ts \
	src/lib/components/files/__tests__/FileTreeToolbar.test.ts
```

Rollback: remove the mode-specific menu branch; column controls remain intact.

### Render one-column detail rows

Files:

- New `web/src/lib/components/files/FileTreeRowSubtitle.svelte`
- `web/src/lib/components/files/FileTreeRow.svelte`
- `web/src/lib/components/files/FileTreeParentRow.svelte`
- `web/src/lib/components/files/FileTreeChildRow.svelte`
- `web/src/lib/components/files/FileTreeRenderRow.svelte`
- `web/src/lib/components/files/__tests__/FileTree.test.ts`

Work:

- Keep one stable entry row root.
- Move the current title line into a nested flex line.
- Put details-only subtitle markup and accessibility behavior in `FileTreeRowSubtitle`.
- Pass the discriminated profile to the entry row and narrow it by mode.
- Iterate derived detail presentations instead of repeating field-format switches.
- Pass already-sliced filler keys to synthetic rows; the details profile supplies none.
- Preserve disclosure, copy-path, activation, selection, indent guides, and focus classes.

Assertions:

- A file subtitle renders size and modified values by default.
- A folder subtitle omits size.
- Enabling permissions appends it in canonical order and monospace styling.
- Separators are hidden from the accessibility tree.
- Screen-reader text names each detail field.
- Empty available details render `No details available`.
- No metadata `gridcell` exists in details mode.
- Column mode continues to render its configured metadata cells.
- Clicking disclosure still expands without entering the directory.
- Clicking the rest of either row still activates it.
- Copy-path clicks do not activate the row.

Validation:

```sh
bun run --cwd web test -- src/lib/components/files/__tests__/FileTree.test.ts
```

Rollback: the column branch remains behaviorally complete and can become unconditional.

### Make virtual geometry mode-aware

Files:

- New `web/src/lib/components/files/FileTreeDetailsHeader.svelte`
- `web/src/lib/components/files/FileTreeVirtualController.svelte.ts`
- `web/src/lib/components/files/FileTreeVirtualRows.svelte`
- `web/src/lib/components/files/__tests__/FileTreeVirtualRows.test.ts`
- `web/src/lib/components/files/__tests__/file-tree-virtual-layout.logic.test.ts`
- `web/src/lib/components/files/__tests__/file-tree-virtual-anchor.logic.test.ts`

Work:

- Construct one rendering profile in the virtual host and select numeric geometry independently from the same policy module.
- Pass only the numeric geometry through a getter-backed controller option.
- Initialize the first virtual layout and TanStack options from that geometry.
- Replace hard-coded header calculations with the active scroll margin.
- Extend the existing `$effect.pre` to snapshot `scrollTop` before a geometry-changing DOM flush.
- Detect layout geometry changes separately from ordering changes and retire the narrower coarse-pointer bookkeeping.
- Disable native overflow anchoring on the controlled viewport.
- Remeasure and restore the logical anchor or physical end on geometry changes.
- Publish independent row and disclosure CSS variables.
- Put the semantic one-column header in `FileTreeDetailsHeader`.
- Consume profile-derived column count, grid template, and minimum width.

Required test cases:

- Fine-pointer details mode uses a 44 px row, 0 px visual header margin, and 28 px disclosure.
- Coarse-pointer details mode uses a 52 px row and 36 px disclosure, so the 16 px subtitle line fits exactly.
- A cold load with persisted details mode initializes with a 0 px margin and 44 px fine row estimate.
- Details mode reports one accessible column and retains a row-1 hidden column header with `aria-sort` and `aria-colindex="1"`.
- First file row remains `aria-rowindex="2"`.
- Desktop details mode uses a 240 px minimum; mobile caps it at 100%.
- A pure anchor/layout test maps the old row key and content-relative offset to the expected new physical offset.
- Toggling mode at a nonzero scroll offset restores that deterministic physical offset and retains the same focused row key.
- The offset is captured before DOM removal or browser clamping; `overflow-anchor` is disabled.
- Toggling columns to details at the physical end restores to the new details-mode end.
- Toggling details to columns at the physical end restores to the smaller column-mode end.
- A deep details-mode anchor maps into columns instead of being misclassified as the new physical end.
- Removing the visual header may transiently clamp the viewport without aborting the final anchor or end restoration.
- Toggling mode while a row is focused retains DOM focus on the same row key.
- A deferred anchor restore does not overwrite user scrolling during a mode change.
- Switching mode does not call `sortEntries` or rebuild the logical row model.
- The 100,000-row directory keeps a bounded mounted window in both modes.

Representative mode-switch test:

```ts
it('preserves the visible anchor and focused row across view geometry changes', async () => {
	const { container, store } = renderRows(1_000);
	const treegrid = getTreegrid(container);
	treegrid.scrollTop = 640;
	await fireEvent.scroll(treegrid);
	const anchor = firstVisibleActionableRow(container);
	anchor.focus();
	const key = anchor.dataset.fileTreeRowKey;

	store.setViewMode('details');

	await waitFor(() => {
		const restored = rowByKey(container, key);
		expect(document.activeElement).toBe(restored);
		expect(treegrid.scrollTop).toBeCloseTo(992, 0);
	});
});
```

The expected offset is derived from the layout contract, not a visual guess: with the test's 640 px fallback viewport and `scrollTop = 640`, the column layout's first visible row is index 22 with an offset of -24 px from the content viewport. In the details layout it restores to `22 * 44 - (-24) = 992`. A companion pure test exercises the transform directly. The UI suite uses happy-dom, whose default element rectangles are zero, so comparing `getBoundingClientRect().top` before and after would be both vacuous and the wrong invariant: removing the 32 px sticky header intentionally changes the row's viewport-relative rectangle.

The automated end tests cover both directions. The old column maximum is 27,392 px and the details maximum is 43,360 px for 1,000 rows in the 640 px viewport. The test viewport models browser clamping from the actual committed header and virtual-body heights, including both eager clamping and clamping deferred until layout. The lazy-clamp regression also forces an intervening layout from an earlier-registered animation-frame callback before the restore callback, so removing the controller's explicit layout read makes the test fail rather than allowing an unclamped baseline and guard to agree. A near-end anchor test proves that the transient 27,360 px maximum after the 32 px header is removed is accepted without weakening the user-scroll guard, and a deep details-to-columns test proves that the smaller column maximum is not mistaken for an old-coordinate end position.

Validation:

```sh
bun run --cwd web test -- \
	src/lib/components/files/__tests__/FileTreeVirtualRows.test.ts \
	src/lib/components/files/__tests__/file-tree-virtual-layout.logic.test.ts \
	src/lib/components/files/__tests__/file-tree-virtual-anchor.logic.test.ts
```

Rollback: select the column profile unconditionally and restore the visible header.

### Complete project validation

Regenerate messages, format touched files, then run:

```sh
bun run check
bun run test
timeout 30s bun run start --port 0
```

The startup check passes when the server reports a listening URL before the timeout. A timeout after successful startup is expected; compilation or startup errors are not.

Manual verification:

- Open Files in main, sidebar, and mobile presentations.
- Scroll into a directory with enough rows to virtualize.
- Focus and select a visible file.
- Toggle details mode repeatedly and verify the same file remains focused, selected, and in place.
- Expand nested directories before and after switching modes.
- Toggle each detail field and verify subtitle order and fallback.
- Change sort key and direction from the popup.
- Return to column mode and verify the prior column widths and visibility.
- Rapidly switch chats while Files is visible and verify no focus or scroll jump.
- Verify dark and light themes use only existing semantic foreground, muted, border, card, accent, and focus-ring tokens.
- Verify long names, long permission strings, deep nesting, and missing timestamps truncate without overlap.
- Verify coarse-pointer controls in a touch-emulated viewport.
- At a 360 px viewport height, verify the expanded details menu scrolls and every sort item is reachable.
- Verify keyboard navigation through the popup and treegrid.

## Test Coverage Matrix

| Area | Test file | Coverage |
| --- | --- | --- |
| Preference and sort state | `web/src/lib/files/tree/__tests__/file-tree.test.ts` | Defaults, persistence, validation, visible sort keys, atomic transitions. |
| View policy | `web/src/lib/components/files/__tests__/file-tree-view-profile.logic.test.ts` | Exhaustive mode projections, field lists, widths, accessible counts, and geometry. |
| Formatting | `web/src/lib/components/files/__tests__/file-tree-entry-presentation.logic.test.ts` | Size, relative time, missing data, permissions. |
| Popup and rows | `web/src/lib/components/files/__tests__/FileTree.test.ts` | Checkbox, non-closing controls, radio state, subtitle output, stable row shell. |
| Responsive popup | `web/src/lib/components/files/__tests__/FileTreeToolbar.test.ts` | Overflow ordering, mode controls, radio presence, and keyboard reachability. |
| Column header | `web/src/lib/components/files/__tests__/FileTreeColumnHeader.test.ts` | Existing resize and header sorting remain unchanged. |
| Virtual UI | `web/src/lib/components/files/__tests__/FileTreeVirtualRows.test.ts` | Cold-load and switched geometry, anchor, end, focus, ARIA, widths, bounded mount count. |
| Virtual math | Existing layout and anchor logic tests | 44/52 px logical heights and zero scroll margin. |
| Full suite | `bun run test` | Cross-feature regression coverage. |
| Static checks | `bun run check` | Svelte, TypeScript, ESLint, architecture rules. |
| Compile/start | `bun run start --port 0` with timeout | Generated messages and SPA/server startup. |

No server integration test is required because the request does not cross HTTP, WebSocket, persistence-service, provider, or process boundaries. The residual risk is browser-specific visual and screen-reader behavior; manual browser and accessibility verification covers that surface.

## Alternatives Considered

### Independent presentation booleans

Rejected:

```ts
showDetailsInRow
showColumnHeader
showMetadataCells
useTallRows
showSortMenu
useNarrowMinimumWidth
```

These encode one product choice repeatedly and permit inconsistent states. A two-value mode is smaller and exhaustive.

### Separate visibility settings for subtitles

Rejected because it duplicates the existing three field choices and makes switching modes surprising. The same metadata remains relevant regardless of layout.

### Always show every detail in details mode

Rejected because it ignores the user's existing field choices, forces permissions into the default UI, and requires a second explanation for why the checkboxes stop applying.

### Combine sort key and direction into one enum

Rejected because four keys times two directions creates eight menu states and duplicates the store's already-correct `sortKey` and `sortDirection` model.

### Keep the column header visible above details rows

Rejected because it contradicts the requested one-column subtitle presentation and retains width and sorting affordances that no longer correspond to visual cells.

### Remove all semantic headers

Rejected because the active sort still needs a supported `aria-sort` location. A visually hidden one-column header exposes it and lets the existing absolute row-count and row-index convention remain identical in both modes.

### Switch details mode to `role="tree"`

Rejected because the current flat virtualized DOM would need correct per-level `aria-posinset` and `aria-setsize`, plus a second row/cell role model. Retaining one accessible treegrid column is simpler and more accurate.

### Duplicate `FileTreeRow` into column and details components

Rejected because disclosure, icons, copy path, selection, activation, focus, and nesting would have two implementations. One stable row root with a mode-specific metadata region keeps behavior shared.

### Separate column and details virtualized views

Rejected after focused review. Changing row height and header margin changes the coordinate system, so a separate component does not eliminate anchor restoration.

If the inactive view is destroyed:

- The scroll container and focused row are unmounted.
- The outgoing view must capture a logical anchor and hand it to a fresh virtualizer.
- The incoming view must reproduce the controller's delayed measurement, focus mounting, and token-guarded restore behavior.
- A large tree can flash at the top before the replacement view restores.

If the inactive view stays mounted:

- Two virtualizers, observers, update effects, row subtrees, and accessibility trees remain active.
- Hidden layout measurement is stale or falls back to the synthetic 640 px viewport.
- The two scroll positions diverge and still require synchronization or restoration.
- Focus and query scoping become ambiguous across duplicate row keys.

Both forms duplicate the hardest behavior while adding a public anchor-handoff contract. The selected design instead separates the details header and subtitle presentation while keeping one virtual host, controller, interaction state, scroll element, and focusable row shell.

### Variable-height subtitles

Rejected because wrapping makes TanStack measurement, compressed virtual coordinates, focus retention, and anchor restoration more expensive and less predictable. One line plus a fixed mode height satisfies the requested subtitle.

### Key the virtual tree by view mode

Rejected because it would intentionally remount the heavy tree, lose DOM focus, and risk scroll jumps. Geometry belongs in the existing controller.

### Automatically enable details mode on narrow surfaces

Rejected because the request specifies a checkable option, and automatic switching would make the persisted choice and cross-surface behavior ambiguous.

## Rollout and Rollback

The feature ships without a flag:

- Default mode is existing column behavior.
- The new path is activated only after user choice.
- Preference failure falls back to columns.

Rollback is client-only:

- Make column mode unconditional.
- Remove the checkbox and sort section.
- Ignore or remove the local-storage key.
- No data or protocol rollback is needed.

## Observability

No production telemetry is added. The feature performs no network or durable mutation, and existing UI errors are not involved. Confidence comes from deterministic store/component tests, the virtual layout tests, full static/test validation, and manual browser verification.

## Review Record

Three design review passes were completed against the repository and this design: an initial exhaustive review, a focused comparison of shared versus separate virtualized views, and a final consistency check of the revised architecture. Both sessions were then resumed for an adversarial code-versus-design review of the committed implementation.

- Kimi K3 through `pi`, model `moonshotai/kimi-k3`, maximum thinking, session `consult-kimi-files-details-20260731`.
- Claude Opus through `claude`, model `opus`, maximum effort, session `9e24d1c7-07a6-4552-9dcf-641aa3e45e8d`.

Both reviewers independently recommended one long-lived virtual host/controller with presentation-level separation, not separate column and details virtualizers. The follow-up review specifically compared a shared renderer, a shared host with separate presentations, and fully separate views.

Validated findings incorporated:

- Replaced scattered mode-derived store/component getters with one discriminated component-layer `FileTreeViewProfile`.
- Added separate `FileTreeDetailsHeader` and `FileTreeRowSubtitle` components while preserving the focusable row root.
- Changed synthetic rows to receive a grid template and pre-sliced filler keys, never a mode prop.
- Made the controller consume numeric geometry rather than presentation mode.
- Added pre-DOM scroll capture to the existing `$effect.pre` and disabled native overflow anchoring.
- Extended physical-end preservation to geometry changes.
- Initialized a persisted details view from details geometry on its first frame.
- Corrected coarse disclosure size from 44 px to 36 px so the subtitle fits the 52 px row.
- Replaced the vacuous rectangle comparison with deterministic physical-offset and pure anchor tests for happy-dom.
- Added `aria-colindex="1"` to the details header and corrected the rationale for retaining it.
- Kept the popup open for mode and sort selections so both sort choices can be made in one visit.
- Corrected focused test commands to use paths relative to `web`.
- Clarified that ARIA counts include an existing header rather than requiring one.
- Required unconditional geometry-snapshot cleanup and nonduplicated compatibility constants.
- Kept short-viewport menu scrolling in manual verification while testing radio presence and keyboard reachability in happy-dom.
- Captured an exact committed-layout automatic-restore baseline so transient browser clamping is distinguishable from a later user scroll without widening the restore tolerance.
- Forced layout before capturing that baseline so both eager and layout-deferred browser clamping follow the same restoration path.
- Made the lazy-clamp regression model an intervening pre-restore layout and verified that deleting the forced read fails the test.
- Limited the new-maximum clamp fallback to viewport-only changes so a shrinking row geometry cannot misclassify a deep anchor as the physical end.
- Added browser-like clamp coverage for both mode directions, a near-end transient clamp, a deep shrinking-layout anchor, and deferred user scrolling.

The final resumed passes from both reviewers found no remaining admissible issue. Real-browser layout, visual, and screen-reader behavior remains part of the manual verification checklist rather than an automated claim.

Review suggestions not adopted:

- Fully separate virtualized views were rejected for the lifecycle, focus, duplication, and anchor-handoff costs above.
- A new file-size validity guard was rejected because `common/file-contracts.ts` already rejects negative and non-finite sizes at the client boundary.
- A static hidden-header name was rejected because the current sort field remains valuable screen-reader context; the localized dynamic name is retained.

The reviewers differed only on where to declare the fixed pixels: one favored injected numeric metrics and one favored controller-owned geometry. The resolved design declares the fixed profiles in the pure component-layer policy module, derives geometry independently from the width-sensitive rendering profile, and injects only numbers into the controller. The controller still owns coarse-pointer selection and every coordinate calculation without learning presentation mode.

## Acceptance Criteria

- `Show details in row` is available and persisted.
- Column mode remains the default; its rendering, sizing controls, sorting, and normal interaction behavior remain unchanged.
- Details mode shows one stable title line and one stable subtitle line for each file or folder.
- The configured metadata fields determine both columns and subtitle contents.
- No visual column header, metadata gridcells, resize handles, or width reset action appears in details mode.
- Sort key and direction are accessible at the bottom of the popup in details mode.
- Switching modes preserves column settings, selection, focus, expansion, and visible anchor.
- The virtual host, scroll container, controller, interaction state, and focusable row roots do not remount on a mode switch.
- Geometry transitions capture pre-DOM scroll state and preserve either the logical anchor or physical end.
- Details mode remains bounded and responsive for 100,000 rows.
- Treegrid row/column counts, indexes, and sort state remain coherent.
- No new effect, dependency, API, protocol, or server behavior is introduced.
- Paraglide generation, `bun run check`, `bun run test`, and startup validation pass.
- Manual main/sidebar/mobile and rapid-switch checks pass without overlap, focus jump, or scroll jump.

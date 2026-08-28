# Virt: Transactional Vertical Virtualization

Status: implemented; physical iPhone validation outstanding.
Target baseline: Garcon `de81381807ef0cfc82ee2ab2fc05ef6c45e8adae`.
Last updated: 2026-08-27.
Review status: code review complete; physical-device review outstanding.

## Summary

Garcon replaces TanStack Virtual with a narrow,
first-party, single-lane vertical virtualizer under `web/src/lib/virt/`.
The pure geometry and correction state machine remain framework-neutral.
A Svelte 5 controller with a private DOM driver owns attachment lifecycle,
measurement ingress, the rendered geometry snapshot, and every physical scroll
write. Synchronous transactions publish geometry; one coalesced post-commit
microtask observes the committed sizer before any planned physical write.

The design addresses the failure class behind the former mobile jump and
snap-back behavior: row measurement, rendered transforms, sizer extent,
tracked scroll coordinates, and corrective scroll writes crossed several
independently scheduled owners. The replacement makes those operations one
ordered transaction. While touch dragging or momentum is active, the
transaction paints a temporary visual deviation instead of writing
`scrollTop`; the deviation is redeemed after native scroll activity becomes
idle. The gate uses explicit touch activity rather than user-agent detection,
so it protects iOS WebKit without excluding other touch browsers.

The implementation is an internal Garcon library, not a published
package. Its boundaries deliberately permit later extraction:

- `virt` imports no Chat, component, Garcon state, or transport modules.
- The pure core imports neither Svelte nor browser globals.
- Transcript paging, row construction, pin policy, reading-anchor policy,
  content readiness, and retention remain consumers of `virt`, not features
  inside it.
- The public surface is limited to stable keyed vertical-list geometry,
  attachments, measurement, explicit scroll activity, and imperative scroll
  targets.
- No compatibility layer reproduces TanStack's option object or mutable
  instance API.

The transcript and five ordinary surfaces now consume Virt, and the TanStack
dependencies and patch are removed. Package extraction remains deferred until
the iOS behavior has been validated on physical devices and the internal API
has remained stable across those materially different consumers.

## Problem

The transcript combines requirements that ordinary virtual lists usually do
not own together:

- Dynamic rows whose height changes after mount, including streaming messages,
  syntax highlighting, CodeMirror-backed tool content, images, disclosures,
  permissions, and responsive text scaling.
- Earlier-history prepend while preserving one exact keyed reading position.
- End pinning that depends on mutation intent, not merely distance from the
  bottom.
- Retained off-range rows for focus, selection, transient UI, target
  navigation, pending earlier-page ownership, and the active transcript tail.
- Cancellation across navigation, chat switch, reset, visibility, scale, user
  reversal, custom scrollbar dragging, touch dragging, and momentum.
- iOS WebKit, where writing `scrollTop` during momentum interrupts the fling.
- Transcript-ledger paging rules: the selected transcript never trims either
  edge while the user reads or a paging/scroll mutation is in flight; expanded
  state is discarded on chat switch and restored only from the bounded recent
  cache.

The range calculation itself is not the difficult part. The difficult part is
coordinating an asynchronous size correction with what the browser paints and
with the provenance of the current scroll.

TanStack Virtual performed part of that coordination inside its core, while
Garcon performed product policy and additional settlement above it. This
division left neither owner able to make the complete transaction atomic. The
local patch fixed specific upstream races, but not the ownership boundary.

## Goals

- Preserve a stable keyed row and its viewport offset through prepend,
  estimate correction, measured resize, reset, and responsive scale changes.
- Measure first-time mounted rows before paint in one read batch, including
  while the user is scrolling.
- Never write `scrollTop` during touch dragging or momentum for measurement,
  prepend, or end-follow corrections.
- Treat explicit navigation as separate provenance from measurement and
  end-follow work; later browser scroll events never change that provenance.
- Make measurement, geometry, visual positions, sizer extent, and correction
  one explicitly ordered transaction.
- Keep all physical scroll writes behind one controller.
- Preserve exact cancellation and surface-identity semantics.
- Preserve the existing transcript paging, retention, focus, target,
  visibility, and bottom-following product contracts.
- Use canonical Svelte 5 runes and attachments rather than legacy stores or
  actions.
- Keep the core small enough to understand, property-test, and maintain.
- Make the internal API suitable for later extraction without expanding v1
  scope for hypothetical consumers.
- Remove the Bun patch and TanStack dependencies after every consumer migrates.

## Non-goals

- Horizontal virtualization.
- Window scrolling.
- Multiple lanes, grids, masonry, or sticky-row layout.
- RTL coordinate handling.
- Smooth scrolling or animated target navigation.
- Server rendering. Garcon remains SPA-mode, although browser access stays in
  the Svelte driver rather than the pure core.
- Owning transcript data, paging cursors, mutation clocks, cache retention, or
  ledger addressing.
- Choosing which transcript row is semantically appropriate as a reading
  anchor.
- Solving arbitrary layout shift inside one visible row. A virtualizer can
  preserve the row's top; it cannot infer which inner CodeMirror line, image,
  or nested DOM node the user considers the anchor.
- Migrating every virtual surface in the transcript cutover itself.
- Publishing a standalone package in the initial implementation.
- A live production feature flag that runs TanStack and Virt concurrently.

## Governing transcript constraints

`docs/transcript-ledger-v5-design.md` remains authoritative for transcript
data and UX behavior. Virt must preserve these constraints:

- Within one transcript view, durable rows remain in exact ordinal order.
- Equal-content occurrences are distinct. Virt performs no client-side
  content deduplication.
- HTTP history paging may return zero visible rows with a non-null earlier
  continuation. The transcript owner, not Virt, follows the continuation.
- Active append, prepend, paging, and scroll mutations never trim either edge
  of the selected transcript.
- Expanded state belongs only to the selected chat. Chat switch or reload
  discards it; returning restores only the bounded recent cache and its raw
  earlier continuation.
- Manual native-history reload is the sole full-transcript replacement path
  and changes `transcriptViewId`; ordinary appends and pages do not.
- Held earlier pages and replaced transcript views remain fenced by the Chat
  domain before keys reach Virt.

Virt receives an ordered key/estimate snapshot. It does not know ordinals,
view IDs, HTTP cursors, mutation clocks, page availability, or providers.

## Pre-migration baseline

### Transcript ownership

At the target baseline, the transcript adapter spanned:

- `web/src/lib/components/chat/ConversationFeed.svelte`: constructs the
  projection and virtual controller, captures old geometry before projection
  publication, renders the sizer, and renders keyed absolute rows.
- `web/src/lib/components/chat/ConversationFeedVirtualController.svelte.ts`:
  979 architecture-budget lines owning TanStack options, measurement
  attachment, visibility, retention range extraction, structural
  classification, anchor restoration, end convergence, target navigation, and
  cancellation.
- `web/src/lib/components/chat/conversation-feed-virtual-runtime.ts`: 703
  architecture-budget lines owning scroll epochs, earlier-prepend ownership,
  mounted-row lookup, anchor capture and settlement, root-offset observation,
  target settlement, and bounded convergence loops.
- `web/src/lib/components/chat/conversation-feed-viewport-geometry.ts`: 212
  architecture-budget lines of Garcon-owned policy for structural changes,
  reading-anchor choice, viewport coverage, retained ranges, target readiness,
  and fill classification.
- `web/src/lib/components/chat/ConversationFeedVirtualRow.svelte`: renders
  `translateY(virtualItem.start - scrollMargin)`, registers measurement and
  pending-anchor attachments, and preserves focus retention.
- `web/src/lib/components/chat/conversation-feed-virtual-items.ts`: constructed
  stable namespaced keys, estimates, targets, and the feed model. This remains
  a Chat concern after migration.

All design line budgets use the repository architecture test's
`readFileSync(...).split('\n').length` metric, including its trailing segment,
not `wc -l`.

`ConversationFeedProjectionState.svelte.ts` already published an atomic
geometry description:

```ts
export interface ConversationVirtualGeometrySnapshot {
	surfaceIdentity: string;
	geometryRevision: number;
	keys: readonly string[];
	estimates: readonly number[];
	measurementReset: 'none' | 'all';
	mutationKinds: ReadonlySet<ConversationFeedMutationKind>;
	endBehavior: ReturnType<typeof conversationFeedEndBehavior>;
}
```

The replacement reuses this publication boundary. Chat converts the
Chat-specific mutation and end behavior into one explicit Virt mutation and
applies it synchronously before Svelte commits the new row projection.

`web/src/lib/chat/transcript/conversation-viewport-port.ts` was the
controller-facing seam, but its contract was incomplete for painted deviation.
The cutover extended it with a provider-neutral logical viewport position and
routed direction inference, start detection, and earlier-page proximity
through that query. The scroll controller remains independent of the concrete
virtualizer.

### Patch contract

The root Bun patch pinned `@tanstack/virtual-core@3.17.8` and protected:

- A connected element replacing the old element for the same key.
- Rejection of a delayed `ResizeObserver` entry whose index now identifies a
  different key.
- Full compensation for above-viewport shrink while scrolling backward.
- Cancellation of a delayed reconciliation.
- Cancellation of a deferred iOS adjustment before a later user offset can be
  overwritten.

`web/src/lib/components/chat/__tests__/tanstack-virtual-core-patch.test.ts`
locked these behaviors. Each behavior became a provider-independent Virt
invariant test before the patch was removed.

### Other consumers

The file tree, commit list, diff viewport, changed-file tree, and sidebar chat
list used a smaller ordinary vertical-list surface. They migrated after the
transcript proved the shared controller contract, allowing all TanStack
dependencies to be removed.

`web/src/lib/components/virtual/fixed-virtual-window.svelte.ts` is an existing
Garcon-owned fixed-height virtualizer. It remains independent until the final
optional migration; replacing it early adds risk without proving dynamic chat
behavior.

## Prior art

Research inspected pinned source rather than package documentation alone.

### TanStack Virtual

Inspected revision:
[`e9874f033c74afd3251eeb9f3e60b2530cc7ae88`](https://github.com/TanStack/virtual/tree/e9874f033c74afd3251eeb9f3e60b2530cc7ae88).

- Single-lane lookup uses compact start/size arrays, binary search, and a
  forward visible walk.
- Stable item keys own measured-size and mounted-element caches.
- Default measurement prefers `ResizeObserverEntry.borderBoxSize`, then a
  cached size, then an `offsetHeight`/`offsetWidth` fallback.
- [PR #1144](https://github.com/TanStack/virtual/pull/1144) deliberately skips
  synchronous mount reads during ordinary scrolling. That creates the
  estimate-before-observer interval seen in Garcon.
- Scroll correction must update internal tracked offset at the same logical
  time as the write. [PR #1176](https://github.com/TanStack/virtual/pull/1176)
  added this for prepend.
- Closely related fixes include
  [#1199](https://github.com/TanStack/virtual/pull/1199),
  [#1209](https://github.com/TanStack/virtual/pull/1209),
  [#1212](https://github.com/TanStack/virtual/pull/1212),
  [#1236](https://github.com/TanStack/virtual/pull/1236), and
  [#1239](https://github.com/TanStack/virtual/pull/1239). Together they show
  that measurement, transforms, tracked offset, and DOM writes require one
  ordered transaction.
- [Issue #884](https://github.com/TanStack/virtual/issues/884) has tracked iOS
  momentum interruption since 2024-11-22.
- [Issue #1250](https://github.com/TanStack/virtual/issues/1250) demonstrates
  that deferral keyed by generic scrolling also captures programmatic scroll
  events and causes an incorrect paint followed by a snap.
- [PR #1254](https://github.com/TanStack/virtual/pull/1254) proposes touch
  provenance. Draft [PR #1189](https://github.com/TanStack/virtual/pull/1189)
  proposes painted CSS compensation during momentum. Neither was merged at
  the inspected revision.

TanStack's Svelte adapter is a thin legacy `svelte/store` wrapper around the
framework-neutral core. Its separation is useful prior art; its adapter style
is not the desired Svelte 5 boundary.

### React Virtuoso

Inspected revision:
[`5c55535944fc40d65ba4f329960976ab6a8f7884`](https://github.com/petyosi/react-virtuoso/tree/5c55535944fc40d65ba4f329960976ab6a8f7884).

The open-source list core uses a temporary visual deviation during Mobile
Safari scrolling and redeems it into physical scroll state after scrolling
stops. Its prepend path similarly stages estimated inserted extent before
physical correction. The relevant implementation is
[`upwardScrollFixSystem.ts`](https://github.com/petyosi/react-virtuoso/blob/5c55535944fc40d65ba4f329960976ab6a8f7884/packages/react-virtuoso/src/upwardScrollFixSystem.ts#L13-L155).

Virt adopts the deviation concept, not Virtuoso's reactive engine or source
code. React Virtuoso Message List is commercial. Its public scroll-modifier
documentation may inform intent names, but its implementation is not a source
for this work.

### Virtua

Inspected revision:
[`2fe8448ec544d5193affdfb72f6c8122bff8f2db`](https://github.com/inokawa/virtua/tree/2fe8448ec544d5193affdfb72f6c8122bff8f2db).

Virtua validates a framework-neutral layout plus framework-specific driver,
and it centralizes resize corrections as pending jumps. It also carries an
explicit reverse infinite-scroll glitch note. Adopting it would replace one
unsettled reverse-scroll dependency with another while leaving Garcon's
semantic anchor, provenance, paging, and cancellation layers intact.

### React Window, React Virtualized, and Svelte lists

- React Virtualized and React Window provide useful simple prefix geometry and
  dynamic-measurement patterns but no comparable prepend/iOS protocol.
- `svelte-tiny-virtual-list` is current Svelte 5 prior art for a compact
  component, but its variable heights are caller/recompute-driven rather than
  continuously observed and corrected.
- `svelte-virtual-list` is a small historical two-pass implementation, last
  maintained in 2022, without later-resize or iOS handling.

No inspected library provides the complete combination required by Garcon.

### Svelte 5

Garcon declares Svelte `^5.56.10`. The design follows the official Svelte
5.56.10 source at
[`56a036f4ce873a24ee6631a06d03d372523d7a9b`](https://github.com/sveltejs/svelte/tree/56a036f4ce873a24ee6631a06d03d372523d7a9b).

- Attachments are the canonical mount/unmount primitive in Svelte 5.29 and
  newer. They run in an effect and return cleanup; attachment factories are a
  documented pattern.
- `Attachment<T>` is a function from the mounted element to optional cleanup.
- Attachment identity is compared by function reference, so a cached per-key
  attachment does not re-run merely because keyed rows reorder; see the pinned
  [`attach()` identity check](https://github.com/sveltejs/svelte/blob/56a036f4ce873a24ee6631a06d03d372523d7a9b/packages/svelte/src/internal/client/dom/elements/attachments.js#L11-L31).
- A Svelte 5.56.10 reproducer verified that `flushSync()` called from
  `$effect.pre` does not commit the state published by that pre-effect before
  returning. It can therefore expose stale sizer bounds, and future Svelte
  async mode rejects `flushSync` inside effects; see the pinned
  [`flush_sync_in_effect` contract](https://github.com/sveltejs/svelte/blob/56a036f4ce873a24ee6631a06d03d372523d7a9b/packages/svelte/messages/client-errors/errors.md#L113-L119).
- A microtask queued after the pre-effect's state write observes Svelte's
  committed DOM before the browser render opportunity. This ordering is a
  release gate in Chromium, Firefox, and desktop WebKit rather than an
  assumption delegated to `tick()`, whose future async-mode implementation
  waits for `requestAnimationFrame` or a timer; see
  [`runtime.js#L503-L522`](https://github.com/sveltejs/svelte/blob/56a036f4ce873a24ee6631a06d03d372523d7a9b/packages/svelte/src/internal/client/runtime.js#L503-L522).

Virt uses stable attachment functions and limits reactive reads inside their
outer setup, preventing unnecessary observer teardown/recreation. No Virt
method calls `flushSync()` or `tick()`; consumers may invoke any method from an
effect.

## Architecture

### Module layout

```text
web/src/lib/virt/
  DESIGN.md
  virtual-list-types.ts
  virtual-list-geometry.ts
  virtual-scroll-deviation.ts
  virtual-list-environment.ts
  virtual-list-transaction.ts
  virtual-list-dom-driver.ts
  virtual-list-controller.svelte.ts
  __tests__/
    virtual-list-geometry.logic.test.ts
    virtual-list-geometry-property.logic.test.ts
    virtual-scroll-deviation.logic.test.ts
    virtual-list-controller.test.ts
    virtual-list-test-harness.ts
```

There is no barrel file. Garcon consumers import the exact module they use.
If the code is later extracted, package entry points are added at extraction
time without changing the internal ownership boundaries.

### Dependency rules

```text
virtual-list-types
        ^
        |
virtual-list-geometry       virtual-scroll-deviation
        ^                              ^
        |                              |
        +------ virtual-list-transaction ------ virtual-list-environment
                              ^                          ^
                              |                          |
                  virtual-list-controller ------ virtual-list-dom-driver
                              ^                          ^
                              +------------+-------------+
                                           |
                                  Chat and other consumers
```

- `virtual-list-types.ts`, `virtual-list-geometry.ts`, and
  `virtual-scroll-deviation.ts` import no Svelte, DOM, `$lib`, or Garcon
  component modules.
- `virtual-list-environment.ts` owns the narrow DOM scheduling and observer
  port plus one frozen production implementation. It imports no Chat or
  component modules.
- `virtual-list-transaction.ts` owns the ordered transaction, commit barrier,
  target resolution, and redemption state machine. It talks to DOM only
  through the driver/environment contracts.
- `virtual-list-dom-driver.ts` owns attachments, listeners, mounted-element
  identity, observer delivery, first-mount batching, and physical coordinate
  reads and writes. It owns no source or Chat policy.
- `virtual-list-controller.svelte.ts` is the small rune-backed public facade.
  It owns the raw snapshot and composes the transaction and DOM driver.
- `web/src/lib/virt/` never imports `web/src/lib/components/` or
  `web/src/lib/chat/`.
- Chat adapters may import Virt.
- The controller accepts an optional environment only as an explicit test and
  extraction seam. Application consumers use the frozen production default.

### Ownership

Virt owns:

- Ordered stable keys and current effective sizes.
- Measured-size cache and mounted-element ownership.
- Prefix coordinates, base visible/overscan ranges, and physical sizer size.
- Viewport/sizer/item attachments and one `ResizeObserver` observing only the
  viewport and mounted items.
- First-mount synchronous read batching.
- Visual deviation and redemption.
- Correction provenance and every physical scroll write.
- Scroll target calculation, clamping, subpixel reconciliation, and
  cancellation of controller-owned work.
- Transaction diagnostics.

The consumer owns:

- The data and stable key source.
- Estimate calculation.
- Mutation intent and semantic reading-anchor selection.
- Whether end pinning applies.
- Retained, focused, selected, pinned, and trailing indexes.
- Paging triggers, cursors, and network activity.
- Rich-content readiness and explicit remeasurement requests.
- Surface hide/show reading-position capture.
- Navigation target semantics.

## Public contract

The initial contract is internal but extraction-quality. Names below are
normative unless implementation discovery identifies a Svelte type constraint
documented in the implementation PR.

### Types

Target: `web/src/lib/virt/virtual-list-types.ts`

```ts
export type VirtualScrollActivity = 'idle' | 'dragging' | 'coasting';

export interface VirtualItem {
	readonly key: string;
	readonly index: number;
	readonly start: number;
	readonly size: number;
	readonly end: number;
}

export interface LogicalVirtualItem {
	readonly key: string;
	readonly index: number;
	readonly start: number;
	readonly size: number;
	readonly end: number;
}

export interface VirtualRange {
	readonly startIndex: number;
	readonly endIndex: number;
}

export interface VirtualPositionView {
	readonly count: number;
	itemAt(index: number): VirtualItem | undefined;
	itemAtOffset(paintedOffset: number): VirtualItem | undefined;
}

export interface VirtualViewportPosition {
	readonly paintedOffset: number;
	readonly logicalOffset: number;
	readonly distanceFromStart: number;
	readonly leadingContentReachable: boolean;
}

export interface VirtualListSnapshot {
	readonly revision: number;
	readonly visibleRange: VirtualRange | null;
	readonly overscanRange: VirtualRange | null;
	readonly sizerSize: number;
	readonly positions: VirtualPositionView;
}

export function virtualItems(
	snapshot: VirtualListSnapshot,
	indexes: readonly number[],
): readonly VirtualItem[];

export type VirtualMutationAnchor =
	| { readonly kind: 'item'; readonly key: string }
	| { readonly kind: 'end' }
	| { readonly kind: 'none' };

interface VirtualItemsSource {
	readonly keys: readonly string[];
	readonly estimates: readonly number[];
	readonly anchor: VirtualMutationAnchor;
}

export type VirtualItemsMutation =
	| ({ readonly kind: 'update' } & VirtualItemsSource)
	| ({ readonly kind: 'reset-measurements' } & VirtualItemsSource)
	| {
			readonly kind: 'replace-surface';
			readonly keys: readonly string[];
			readonly estimates: readonly number[];
	  };

export type VirtualMutationResult =
	| { readonly kind: 'applied' }
	| {
			readonly kind: 'rejected';
			readonly reason: 'duplicate-key' | 'length-mismatch' | 'invalid-estimate';
	  };

export type VirtualResumeTarget =
	| { readonly kind: 'start' }
	| { readonly kind: 'end' }
	| { readonly kind: 'anchor'; readonly key: string; readonly viewportOffset: number };

export type VirtualScrollResult = { readonly kind: 'scheduled' } | { readonly kind: 'not-ready' };

export type VirtualResumeResult = VirtualScrollResult | { readonly kind: 'missing-key' };

export type VirtualIndexScrollResult = VirtualScrollResult | { readonly kind: 'missing-index' };

export type VirtualKeyScrollResult = VirtualScrollResult | { readonly kind: 'missing-key' };
```

`start` and `end` are painted coordinates relative to the sizer's top. The
consumer never sees logical item coordinates or current deviation;
`VirtualViewportPosition.logicalOffset` is the narrow exception needed for
consumer-owned paging and intent. `sizerSize` is the physical CSS height to
render, not the hidden logical total.

`LogicalVirtualItem` has the same shape but remains a core geometry value:
`start` and `end` are pre-deviation prefix coordinates. The Svelte-facing
snapshot exposes only `VirtualItem`.

`VirtualRange.startIndex` and `endIndex` are both inclusive. `null` is the only
empty range. This replaces TanStack's `Range.count`, `Range.startIndex`,
`Range.endIndex`, and `defaultRangeExtractor` contract explicitly rather than
depending on an adapter-compatible interpretation.

`VirtualPositionView` is read-only and valid only for its captured snapshot
revision. It hides the controller's capacity arrays and provides a pure lookup
surface;
`virtualItems(snapshot, indexes)` sorts and de-duplicates indexes, resolves
every explicitly requested item from that view, including retained focus or
selection rows. The base overscan range, not this helper, clamps its start past
items whose painted `end <= 0`; newly prepended range-only rows therefore do
not paint above the sizer while positive deviation is pending, but a
consumer-retained row is never silently unmounted. A navigation request
redeems deviation before targeting a currently unreachable row.

`itemAtOffset(paintedOffset)` performs the same zero-height-safe binary search
in painted coordinates. It replaces Chat's TanStack
`getVirtualItemForOffset` dependency. Reading-anchor selection and hidden
offset capture pair this result with `VirtualViewportPosition.paintedOffset`;
they never combine a painted item start with `logicalOffset`.

`keys.length` must equal `estimates.length`; keys must be unique; estimates
must be finite and nonnegative. A violation returns `rejected`, retains the
prior geometry and snapshot, and emits a transaction diagnostic. Development
builds may additionally throw after recording the rejection; production never
lets invalid source geometry tear down the transcript effect above the row
boundaries.

The discriminated mutation separates ordinary updates, measurement resets,
and surface replacement. It avoids boolean-flag overload and makes cache and
deviation semantics explicit:

- `update`: retains measurements for surviving keys and prunes removed keys.
- `reset-measurements`: clears measurements before applying the update and
  preserves the requested anchor.
- `replace-surface`: clears measurements, mounted ownership, cached
  attachments, deviation, and pending owned work without preserving old
  pixels. It enters a not-ready state until the consumer issues the new
  surface's first explicit target.

### Controller

Target: `web/src/lib/virt/virtual-list-controller.svelte.ts`

```ts
import type { Attachment } from 'svelte/attachments';
import type {
	VirtualIndexScrollResult,
	VirtualItemsMutation,
	VirtualKeyScrollResult,
	VirtualListSnapshot,
	VirtualMutationResult,
	VirtualResumeResult,
	VirtualResumeTarget,
	VirtualScrollActivity,
	VirtualScrollResult,
	VirtualTransactionRecord,
	VirtualViewportPosition,
} from './virtual-list-types.js';
import type { VirtualListEnvironment } from './virtual-list-environment.js';

export interface VirtualListControllerOptions {
	get overscan(): number;
	get measurementAnchor(): 'geometric' | 'end';
	readonly environment?: VirtualListEnvironment;
	onTransaction?(record: VirtualTransactionRecord): void;
}

export class VirtualListController {
	constructor(options: VirtualListControllerOptions);

	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	get snapshot(): VirtualListSnapshot;
	get viewportPosition(): VirtualViewportPosition | null;
	get ownsScrollPosition(): boolean;
	item(key: string): Attachment<HTMLElement>;
	measuredSize(key: string): number | undefined;

	apply(mutation: VirtualItemsMutation): VirtualMutationResult;
	setScrollActivity(activity: VirtualScrollActivity): void;
	refreshLayout(): void;
	remeasure(element: HTMLElement): void;
	remeasureAll(): void;
	suspend(): void;
	resume(target: VirtualResumeTarget): VirtualResumeResult;

	scrollToIndex(
		index: number,
		options?: { readonly align?: 'start' | 'center' | 'end' },
	): VirtualIndexScrollResult;
	scrollToKey(
		key: string,
		options?: { readonly align?: 'start' | 'center' | 'end' },
	): VirtualKeyScrollResult;
	scrollToAnchor(key: string, viewportOffset: number): VirtualKeyScrollResult;
	scrollToStart(): VirtualScrollResult;
	scrollToEnd(): VirtualScrollResult;
	scrollBy(delta: number): VirtualScrollResult;
	cancelOwnedScroll(): void;
	destroy(): void;
}
```

The controller has no raw `scrollTop` setter and no API requiring callers to
inspect pending deviation. Every target method resolves deviation and
physical bounds internally. A successful result is `scheduled`, not
`applied`, because the write occurs only after Svelte commits the target
sizer. `not-ready` means no attached, initialized viewport. Key and index
methods add only their own missing-target case; targeting does not require the
row to be mounted because prefix geometry is sufficient.

`scrollBy(delta)` expresses a logical list-coordinate delta in CSS pixels. If
deviation is pending, the controller publishes zero-deviation geometry and
schedules one target at `currentLogicalOffset + delta`; it never applies the
delta to the stale physical offset and then redeems separately.

Logical targets may be negative when leading content precedes the sizer inside
the scroller. Final target resolution clamps only the resulting physical
`scrollTop`, allowing consumers to reach that leading content.

`viewportPosition` is the provider-neutral query used by consumers that own
anchor, paging, or direction policy. `paintedOffset` is `physicalOffset` and
pairs with painted `VirtualItem.start`/`end`; viewport-relative row position is
`item.start - paintedOffset`. `logicalOffset` is
`physicalOffset + deviation` and is used only for paging, direction, and start
detection; `distanceFromStart` is its clamped distance from logical zero.
While a post-commit write is pending, the position reports that write's
attainable painted target so it remains coherent with the already-published
snapshot instead of pairing final positions with the pre-write DOM offset.
`leadingContentReachable` is true when the physical target for logical zero is
not above scroll zero. A physical maximum below that target does not make
already-visible leading content unreachable. A consumer must not request
another earlier page while it is false. The query is `null` while detached,
suspended, or waiting for a replacement surface's first target.

`ownsScrollPosition` is true from immediately before any Virt-authored
`scrollTop` assignment through the next post-write animation-frame
reconciliation. This includes target navigation, immediate correction, and
idle deviation redemption. A matching browser `scroll` event records the
attained offset but does not clear ownership; all listeners on the target must
observe the owned epoch regardless of registration order. The post-write frame
clears the same epoch after reconciling the attained or no-event/clamped
offset. A newer owned write supersedes the frame, and explicit user intent
cancels the owned epoch before its movement is classified, so ownership cannot
hide a real gesture. The flag is set before the write, not reconstructed from
a later transaction record or cleared from a scroll-listener microtask.

`refreshLayout()` schedules a coalesced post-commit viewport transaction. A
consumer calls it when layout outside the sizer can move the sizer without
resizing the viewport or sizer; `ResizeObserver` cannot report that pure
position change. Chat calls it for toolbar/empty-state padding and composer
tray-reservation changes. Ordinary item publications already schedule the
same post-commit leading-offset read and need no second call.

`setScrollActivity('idle')` schedules a next-frame viewport transaction when
deviation is pending. The frame lets settlement-gated mutations fold into the
same correction before redemption and is invalidated by cancellation.
Non-idle transitions only update the gate; they never manufacture a scroll
write or a range publication.

`measurementAnchor` is consumer policy read at mount/resize transaction time.
`geometric` is the ordinary reading-list behavior. `end` means the consumer is
currently following the end, so later measurement of a streaming or newly
mounted tail remains follow provenance and can defer without losing bottom
pinning. Chat derives it from its existing `restore-if-pinned` policy and
current pin state; Virt never decides that state from distance alone.

`suspend()` detaches active viewport listeners and pauses new DOM measurement
without clearing keyed sizes. While suspended, `apply()` updates and prunes
keys, estimates, measurements, and attachment cache entries, but computes no
correction and publishes no range. Deviation is preserved only while the
surface identity is unchanged. `resume(target)` atomically reattaches,
publishes current geometry, resolves the consumer's reading-anchor/start/end
target against zero-deviation final geometry, and schedules the first owned
navigation write. Pending deviation is redeemed into that one resolved target,
not written separately. It never exposes the pre-suspension snapshot with
stale keys on a visible surface.
If an anchor target key is missing, `resume` still publishes current
zero-deviation geometry, returns `missing-key`, and performs no write; Chat may
then issue its semantic fallback against the visible current snapshot.
Surface-specific hidden reading position remains a Chat concern.
`replace-surface` is the only ordinary path that clears the old cache without
preservation.

`item(key)` returns a stable cached attachment for that key. It does not close
over an index; prepend changes indexes while keys and DOM nodes remain stable.
The controller resolves the current index through its key map. Attachment
cleanup unobserves the element and removes ownership only when that exact
element is still the current owner. The attachment-function cache is pruned
with removed measurements, cleared on `replace-surface`, and cleared on
`destroy()`.

### Environment seam

Target: `web/src/lib/virt/virtual-list-environment.ts`

```ts
export interface VirtualListEnvironment {
	now(): number;
	queueMicrotask(callback: () => void): void;
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
	createResizeObserver(callback: ResizeObserverCallback): ResizeObserver;
}

export const browserVirtualListEnvironment: Readonly<VirtualListEnvironment>;
```

The production object is frozen and delegates directly to browser APIs. Tests
inject scheduling and observer delivery through this port while defining
`scrollTop`, `scrollHeight`, and `clientHeight` on a real happy-dom element.
Those element properties remain the scroll geometry seam; the controller does
not gain an abstract fake-element API. Tests also install scriptable
`getBoundingClientRect()` results on the viewport and sizer; happy-dom's zero
rects cannot model `leadingOffset`. The existing observer harness stays under
`components/shared/__tests__` and may be imported test-to-test, or Virt keeps a
small local observer double. No test helper moves into the production domain
tree merely to share it.

### Rendered index policy

Virt publishes the base visible and overscan ranges. It does not own a
`rangeExtractor`. Consumers merge those ranges with their retained indexes
and call the pure `virtualItems(snapshot, indexes)` helper. The revision-scoped
position view on the snapshot makes this a normal Svelte dependency; no
manual `void snapshot.revision` read or imperative controller lookup is
required.

Chat continues using `retainedConversationRange` for focus, selection,
earlier-prepend ownership, following rows, and the pinned transcript tail.
`ConversationFeedVirtualController.renderedIndexes(snapshot)` remains the
owner of that merge, including mounted-row retention and the configured pinned
gate; `ConversationFeed.svelte` does not reconstruct those inputs. The policy
remains independently unit-testable and does not become part of a future
standalone package. Internally it calls
`retainedConversationRange({ overscanRange, visibleRange, count, retainedIndexes, ... })`,
expands the inclusive overscan range itself, starts the following buffer at
the visible range's end, and no longer calls TanStack's
`defaultRangeExtractor` or reads `Range.count`/`Range.overscan`.

```ts
renderedIndexes(snapshot: VirtualListSnapshot): readonly number[] {
	return retainedConversationRange({
		overscanRange: snapshot.overscanRange,
		visibleRange: snapshot.visibleRange,
		count: snapshot.positions.count,
		retainedIndexes: this.#retainedIndexes,
		trailingStartIndex: this.#configuredPinned ? this.#pinnedTrailingStartIndex : null,
		followingRowCount: CHAT_VIRTUAL_FOLLOWING_BUFFER_ROWS,
	});
}
```

## Geometry

### Representation

Target: `web/src/lib/virt/virtual-list-geometry.ts`

```ts
export class VirtualListGeometry {
	#keys: string[] = [];
	#indexByKey = new Map<string, number>();
	#measurements = new Map<string, number>();
	#estimates = new Float64Array();
	#sizes = new Float64Array();
	#offsets = new Float64Array(1);
	#count = 0;
	#dirtyFrom = 0;

	setItems(keys: readonly string[], estimates: readonly number[]): void;
	replaceItems(keys: readonly string[], estimates: readonly number[]): void;
	resetMeasurements(): void;
	measure(key: string, size: number): number;
	deleteMeasurement(key: string): void;

	indexOf(key: string): number | undefined;
	item(index: number): LogicalVirtualItem | undefined;
	itemAtOffset(offset: number): LogicalVirtualItem | undefined;
	range(offset: number, viewportSize: number): VirtualRange | null;
	totalSize(): number;
	measuredSize(key: string): number | undefined;
}
```

`offsets` has `count + 1` entries:

```text
offsets[0] = 0
offsets[i + 1] = offsets[i] + sizes[i]
item.start = offsets[i]
item.end = offsets[i + 1]
```

The arrays use capacity doubling and `#count`; an ordinary publication does
not allocate three new arrays. The effective size is the keyed measurement
when present, otherwise the current estimate. Updating a size marks its index
dirty. A transaction rebuilds from the smallest dirty index once.

`setItems` compares the incoming sequence with the current keys using a common
prefix and common suffix. It deletes only removed keys, inserts only new keys,
and rewrites suffix map indexes only when their numeric positions shifted.
Estimates are compared independently so a same-key scale reset dirties the
first changed estimate without rebuilding `#indexByKey`. Consequences:

- Tail append/remove performs map writes proportional to changed keys and
  rebuilds only the changed prefix suffix.
- A same-key estimate or measurement update performs no key-map writes.
- Prepend remains `O(n)` because every surviving index shifts. This cost is
  explicit and batched once per page, not hidden behind a full-map rebuild on
  every streaming publication.
- Finding the common prefix/suffix can still compare `O(n)` keys in the worst
  case. Deterministic operation-count tests distinguish cheap comparisons
  from allocations, map writes, and prefix rebuild work.

The geometry object internally owns mutable typed arrays. A
`VirtualPositionView` captures the geometry revision, read-only logical
offset/size arrays, and one deviation scalar applied by `itemAt()`. A
deviation-only publication therefore creates an `O(1)` view and does not copy
20,000 starts. The arrays remain encapsulated; consumers receive values, never
array references. Reading a view after its captured geometry revision is stale
programmer error and throws in development. Svelte consumers derive from the
current snapshot and do not retain views across revisions. Range-only
publication reuses the prior view; a changed deviation creates a new view over
the same logical arrays, and a changed key/size revision advances the captured
revision without exposing mutable capacity.

`VirtualPositionView.itemAtOffset(paintedOffset)` first converts to logical
coordinates with `paintedOffset + capturedDeviation`, then performs the
zero-height-safe binary search over the shared logical offsets and returns a
painted `VirtualItem`. It never searches logical arrays with an unconverted
painted offset.

This is revision-scoped immutability rather than historical snapshot storage.
Future extraction must document the same latest-snapshot rule or adopt
copy-on-write generations before promising that old snapshots remain readable.

### Complexity

- Start/end lookup: `O(1)` after rebuild.
- Offset lookup: `O(log n)` plus a short forward walk.
- Visible range: `O(log n + visible count)`.
- Tail append, removal, or measurement: `O(changed)` mutation and prefix work,
  plus at worst `O(n)` equality comparisons for source diffing.
- Early measurement or prepend: `O(n - firstChangedIndex)`, once per batch;
  prepend also shifts `O(n)` key-map indexes.
- Surface replacement: `O(n)`.

The current model test constructs 20,000 rows. A preliminary Bun benchmark on
this VM rebuilt only the complete 20,000-entry numeric prefix in approximately
20 microseconds. A separate review benchmark measured full
`#indexByKey` reconstruction at 1.89 ms p50 and 4.20 ms p95 for realistic
namespaced keys, which is why a full map rebuild is forbidden on the hot path.
Neither benchmark represents DOM cost or production distribution; a checked-in
benchmark and transaction instrumentation must confirm the complete
transaction.

Fenwick trees, block sums, and Virtuoso's size-run tree are rejected for v1.
They add update/query complexity without evidence that prefix rebuilding is a
bottleneck. Block sums are the first escalation if pure geometry exceeds the
performance threshold.

### Zero-height items

Zero is a valid measured or estimated size. Garcon uses zero-height hidden
tool-result rows. Binary search must account for repeated offsets:

- Find the upper bound of `offsets <= visibleStart`.
- Walk forward past items whose `end <= visibleStart`.
- Include only items with `end > visibleStart && start < visibleEnd`.
- If every remaining item is zero-height, return a deterministic empty visible
  range rather than looping or selecting an arbitrary repeated offset.
- Explicit retained indexes can still render zero-height items.
- Snapshot overscan clamps its published start past items whose painted end is
  at or above zero; consumer-added retained indexes remain renderable outside
  that base range.

Property tests compare every lookup and range against a naive linear model
containing arbitrary zero, fractional, estimated, and measured sizes.

## Coordinate system and visual deviation

The controller maintains:

```text
scrollTop        physical DOM scroll offset
leadingOffset    sizer top expressed in the viewport scroll coordinate system
physicalOffset   scrollTop - leadingOffset
logicalStart(i)  prefix position from current effective sizes
deviation        logical correction painted but not yet redeemed physically
visualStart(i)   logicalStart(i) - deviation
logicalOffset    physicalOffset + deviation
sizerSize        logicalTotal - deviation
```

`VirtualItem.start` is `visualStart`. Range lookup uses `logicalOffset`.
For an element-scroller controller:

```text
leadingOffset =
  sizer.getBoundingClientRect().top
  - viewport.getBoundingClientRect().top
  + viewport.scrollTop
```

The controller reads this value at transaction start and again after Svelte's
commit. `ResizeObserver` remains useful for size changes but is never treated
as sufficient evidence for a pure position change.

The sizer invariant is load-bearing:

```text
last visual item end = logicalTotal - deviation = sizerSize
```

Changing deviation therefore moves items and sizer extent together. During a
deferred correction there is no transient mismatch between the last item and
the sizer and no second browser scroll extent competing with the visual
position.

### Anchor correction

Virt has two anchor owners:

- An item mutation uses the consumer-selected semantic item, `end`, or
  `none`. Chat chooses the reading row before keys change.
- A mount, resize, or leading-offset-only transaction uses the consumer's
  current `measurementAnchor`. `geometric` selects the first item whose old
  painted end exceeds the old painted viewport start; otherwise the last
  item; otherwise no anchor. `end` is allowed only as explicit consumer follow
  policy and uses follow correction. Virt never infers it from distance.

For an item anchor, resolve the key against the old sequence and record its
old logical start and the last committed leading offset. After the complete
batch and current leading-offset read:

```text
correction =
  (newLogicalStart(anchorKey) - oldLogicalStart(anchorKey))
  + (newLeadingOffset - oldLeadingOffset)
deviation = deviation + correction
```

This preserves the row's physical painted coordinate because that coordinate
is `leadingOffset + logicalStart - deviation - scrollTop`. It covers prepend,
estimates becoming measurements, repeated above-viewport changes, measurement
reset, and a toolbar or padding moving the sizer without resizing it. Growth
of the anchor row itself does not change its start, so no correction is
manufactured merely because a viewport-spanning row grows below its top.

The default geometric rule compensates growth and shrink entirely above the visual
viewport, regardless of scroll direction. A partly visible anchor row's own
growth remains uncompensated. These are the two patched TanStack behaviors by
construction rather than by a direction-sensitive size predicate.

When a first-measurement batch includes the geometric row at the viewport top,
Virt advances to the last already-measured row that starts inside the old
viewport when one exists. Pinning the last stable in-view row prevents
interleaved first measurements above it from displacing measured content while
keeping the anchor corridor bounded to what the user can see. This preserves
the ordinary partly visible resize rule.

If the requested key does not exist in both snapshots, the transaction applies
with `anchor: none`, emits a development diagnostic, and performs no guessed
correction. Chat selects any semantic fallback key before calling Virt.

`anchor: end` and an active end measurement anchor mean follow, not explicit
navigation. Their correction is:

```text
correction =
  (newLogicalTotal - oldLogicalTotal)
  + (newLeadingOffset - oldLeadingOffset)
```

When safe, final geometry is published and the post-commit phase writes the
physical maximum. During dragging or coasting, the correction remains painted
as deviation. `anchor: none` publishes without preservation and is used for
explicit navigation or surface replacement.

### Prepend example

Assume the existing first row starts at logical zero and an earlier page adds
estimated extent `E`:

```text
newLogicalStart(oldFirst) = E
correction = E
newDeviation = oldDeviation + E
visualStart(oldFirst) = E - E = 0
newSizerSize = oldLogicalTotal + E - E = oldLogicalTotal
```

Existing content and physical scroll extent remain fixed while touch momentum
continues. After activity becomes idle, redemption grows the sizer and moves
physical scroll by `E` after Svelte commits the grown sizer and before the next
paint. The new earlier rows then become physically reachable without moving
the old reading row. The tradeoff is explicit: until redemption, the inserted
leading rows are behind a physical scroll wall. `viewportPosition` reports
`leadingContentReachable: false`; Chat suppresses another earlier-page request
until redemption. At most one successful earlier page can therefore add
unreachable extent. Reaching the physical top marks redemption as mandatory,
but the write still waits for elastic bounce and coasting to become idle.

### End-follow example

Assume a pinned list of logical extent `T` appends `A` while touch momentum is
active:

```text
newLogicalTotal = T + A
correction = A
newDeviation = oldDeviation + A
newSizerSize = (T + A) - A = T
```

The newest content paints at the existing physical bottom while older content
moves upward, exactly as following requires, but physical extent and
`scrollTop` remain unchanged. Idle redemption grows the sizer by `A` and
writes the new maximum. A streaming append while the user is not pinned uses
an item anchor instead; rows appended below it produce zero correction.

### Redemption

Redemption converts painted deviation into physical scroll state across a
commit barrier:

```text
synchronous transaction:
  compute the final zero-deviation snapshot
  publish final row positions and sizer size
  queue one commit microtask for revision R

commit microtask:
  abort if R was superseded or the surface is not ready
  read the committed sizer position, scrollHeight, clientHeight, and scrollTop
  if leadingOffset changed during the commit:
    fold that delta into the same correction
    republish and queue the next commit barrier; perform no scroll write
  otherwise write scrollTop once and record the intended subpixel target
```

The microtask is controller-owned and coalesced by revision. Two Svelte paths
matter. When publication occurs in `$effect.pre`, Virt queues its commit
microtask from inside the active Svelte flush and the render effects complete
later in that same synchronous flush. When publication occurs from a plain
task or microtask, including mount and observer ingress, the state write
schedules Svelte's flush before Virt queues its own microtask. In both paths,
the Virt microtask observes committed DOM before the browser render
opportunity. The pinned behavior follows Svelte's
[`Batch.ensure()` scheduling](https://github.com/sveltejs/svelte/blob/56a036f4ce873a24ee6631a06d03d372523d7a9b/packages/svelte/src/internal/client/reactivity/batch.js#L858-L872)
and shared
[`queue_micro_task`](https://github.com/sveltejs/svelte/blob/56a036f4ce873a24ee6631a06d03d372523d7a9b/packages/svelte/src/internal/client/dom/task.js#L4-L33)
queue and remains a cross-browser release gate. `flushSync()` and `tick()` are
forbidden in Virt production code: the former does not provide this guarantee
from `$effect.pre`, and the latter may resolve after the paint boundary in
Svelte async mode.

All reads for revision `R` precede its commit write. A leading-offset change
detected after the first publication causes a read/republish barrier, never a
write based on stale coordinates. The commit validates `revision === R` and
surface generation before touching the DOM. A newer transaction supersedes
older pending work rather than allowing two writes.

A semantic transaction permits at most two leading-offset republish barriers
before yielding to the next animation frame with a diagnostic. An unstable
layout never spins the microtask queue and never writes against a stale
offset; the next viewport transaction retries.

For a programmatic absolute target, the controller does not first write a
redemption offset and then write the target. It publishes `deviation: 0`,
resolves the target in final logical geometry, and schedules one final commit
write.

Negative-deviation redemption may clamp when the physical target crosses the
top boundary. Virt redeems at the first idle in-bounds opportunity, records
the unattainable remainder, and reconciles to the browser's attained offset.
That boundary movement is bounded by the pending negative deviation; the
design does not label it a no-jump redemption.

### Deferral gate

The gate uses provenance and touch-derived activity, not generic scroll events
or user-agent detection:

```ts
function shouldDeferCorrection(input: {
	activity: VirtualScrollActivity;
	provenance: 'measurement' | 'follow' | 'navigation';
}): boolean {
	return (
		input.provenance !== 'navigation' &&
		(input.activity === 'dragging' || input.activity === 'coasting')
	);
}
```

Measurement includes item resize, mount correction, prepend, and measurement
reset. Follow is mutation-driven end pinning. Navigation is an explicit
consumer target and never defers, even though the browser subsequently emits
`scroll` events. Garcon's existing
`ConversationNativeScrollActivity = 'idle' | 'dragging' | 'coasting'` flows
through `ConversationViewportPort.setNativeScrollActivity`; the Chat adapter
forwards it to Virt.

Only touch gestures produce `dragging` or `coasting`; wheel, keyboard, and
scrollbar activity leave this input `idle`. No platform dimension or iPadOS
user-agent heuristic is required. The transcript adapter reuses the tested
Chat gesture and settlement owner rather than introducing a second classifier.
Virt consumes activity; it does not publish or infer `isScrolling`.

### Cancellation and boundaries

- `cancelOwnedScroll()` invalidates target/convergence epochs but preserves
  deviation. Discarding a painted deviation would move content immediately.
- `replace-surface` suspends scroll and range tracking, ignores browser clamp
  events caused by the new sizer, clears measurements, mounted ownership,
  attachment cache, deviation, and pending work, and waits for the first
  explicit new-surface target. That target initializes the new generation and
  is the first scroll event the controller owns.
- `suspend()` preserves deviation and measurement cache. Chat captures its
  hidden reading anchor before suspension. `resume(target)` publishes and
  targets current geometry atomically; stale pre-suspension keys never render
  after the surface becomes visible.
- Redemption waits while Safari reports elastic `scrollTop` outside physical
  bounds and retries when an in-bounds idle event arrives.
- A positive deviation may temporarily make newly prepended leading content
  unreachable. At the physical top, iOS may rubber-band and continue reporting
  coasting; Virt marks redeem-on-idle, Chat suppresses more earlier paging,
  and redemption occurs after the bounce settles, roughly 200 ms after the
  final coasting scroll under the current Chat settlement policy.
- A negative deviation can expose a leading visual gap near the physical top.
  The controller requests redemption as soon as activity is idle and
  the target is in bounds, otherwise applies the documented bounded boundary
  correction after settlement. It never writes mid-momentum merely to hide
  the gap.
- An idle deviation older than one second triggers a diagnostic and an
  immediate redemption attempt. A deviation still classified as dragging or
  coasting logs but does not force a momentum-breaking write.

### Unsolicited physical clamps

The browser may change `scrollTop` without a Virt write when viewport bounds
change, notably when an iOS keyboard dismissal increases `clientHeight`.
Virt distinguishes this from active user movement using the current touch
activity plus the viewport/bounds transaction that observed the clamp. User
movement updates the logical viewport normally and is never cancelled.

For an unowned bounds clamp while deviation is pending, Virt starts from the
last committed logical offset, clamps that desired offset to the new logical
bounds, and solves the coordinate equation against the attained physical
offset:

```text
newLogicalMaximum = max(0, logicalTotal - viewportSize)
newPhysicalMaximum = max(0, logicalTotal - currentDeviation - viewportSize)
desiredLogicalOffset = clamp(previousLogicalOffset, 0, newLogicalMaximum)
newDeviation = desiredLogicalOffset - currentPhysicalOffset
```

This folds the representable physical delta into the pending correction
without creating a second clamp loop. When the current sizer still overflows,
`newLogicalMaximum = newPhysicalMaximum + currentDeviation`, so a clamp to the
physical maximum solves back to the current deviation. When the viewport is
larger than the current sizer, both the attained physical offset and physical
maximum are zero; solving to the clamped logical target changes deviation once
so the final sizer either exactly fills the viewport or has logical maximum
zero. The deviation reducer receives this absolute solve with `measurement`
provenance as `correction = newDeviation - currentDeviation`. If the resized
viewport makes the old logical offset impossible, the difference between the
old and clamped logical target is recorded as a bounded viewport-clamp
remainder. The next publication
uses the solved deviation before exposing range state. No unowned clamp is
silently treated as an authored navigation event.

## Ordered transaction

Every source uses an explicit subset of one ordered pipeline. A transaction
never performs a DOM write before its reads and publication complete.

### Read

- Drain pending `ResizeObserver` entries.
- Gather newly connected uncached item elements.
- Validate current key-to-element ownership and connectivity.
- Read `borderBoxSize` values when supplied.
- Batch remaining `offsetHeight` reads.
- Read viewport size, `leadingOffset`, `scrollTop`, and physical bounds.
- Compare the attained physical offset with the last authored/observed offset;
  classify a bounds-induced unowned clamp separately from user movement.
- Compare `leadingOffset` with the last committed value even when no observer
  fired; a pure position change need not resize either observed element.
- Perform no DOM, Svelte state, geometry, or scroll writes.

### Geometry

- Capture the old semantic or geometric anchor from pre-mutation geometry.
- Apply source keys and estimates.
- Apply accepted measurements in current index order.
- Rebuild once from the earliest dirty index.
- Calculate the new base visible and overscan ranges.
- Calculate one correction including any `leadingOffset` delta.

### Deviation decision

- Accumulate the correction into pending deviation.
- Resolve provenance, touch activity, physical redemption bounds, and elastic
  bounds.
- Choose deferred paint, immediate redemption, absolute programmatic target,
  or no write.

### Publish

- Replace one `$state.raw<VirtualListSnapshot>` value only when the visible
  range, overscan range, sizer size, deviation-adjusted position view, or
  key sequence changed. A range-preserving scroll publishes nothing.
- Publish final visual item coordinates and physical `sizerSize` from the same
  logical transaction revision.
- Let Svelte update row transforms and the sizer height together.

### Post-commit

- Queue at most one commit microtask for the latest revision.
- Verify the revision, surface generation, attachment, and ready state.
- Read committed `leadingOffset` and physical bounds. If the leading offset
  changed during the Svelte commit, fold the delta into correction, republish,
  and queue another barrier without writing.
- Perform at most one `scrollTop` write after the committed sizer is visible to
  DOM reads.
- Eagerly record the intended physical target before the later browser scroll
  event.
- Reconcile WebKit's integer-rounded readback against the remembered subpixel
  target within a bounded tolerance.

### Source-to-phase matrix

| Source            | Anchor                                                                                         | Geometry mutation               | Publication/write behavior                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items`           | Consumer item, `end`, or `none`                                                                | Keys, estimates, optional reset | Publishes new geometry; measurement/item preservation uses `measurement`, end pin uses `follow`.                                                           |
| `mount`           | Current measurement anchor (`geometric` or consumer-owned `end`)                               | Batched uncached sizes only     | Runs from the attachment microtask after rows exist; may publish deviation, never reads future items in `$effect.pre`.                                     |
| `resize`          | Current measurement anchor                                                                     | Accepted observer sizes only    | One observer delivery becomes one transaction; an end anchor carries follow provenance.                                                                    |
| `viewport`        | Current measurement anchor if `leadingOffset` changed; prior logical offset for a bounds clamp | None                            | Recomputes range; solves representable unowned clamps with `measurement` provenance before publication; may redeem after activity becomes idle.            |
| `resume`          | Consumer start, end, or keyed viewport-offset target                                           | None                            | Reattaches, publishes zero-deviation current geometry, and schedules one resolved navigation write atomically; stale suspended snapshot never republishes. |
| `programmatic`    | None                                                                                           | None                            | Publishes final zero-deviation geometry if needed, then schedules one navigation write after commit.                                                       |
| `replace-surface` | None                                                                                           | Full reset                      | Publishes not-ready/empty range, performs no write, and ignores clamp events until the first programmatic target.                                          |

An `items` transaction in `$effect.pre` cannot perform mount reads because new
rows do not exist yet. A `viewport` transaction cannot dirty size geometry.
The table is normative for both implementation and operation-order tests.

Deterministic controller and integration tests verify:

- `sizerSize === logicalTotal - deviation` within 0.5 px.
- `sizerSize >= 0`.
- Every published item satisfies `start + size === end`.
- Published indexes and keys match the current source.
- The selected anchor's viewport-relative physical coordinate is preserved
  within 0.5 px:
  `leadingOffsetAfter + newPaintedStart - intendedScrollTop` equals
  `leadingOffsetBefore + oldPaintedStart - scrollTopBefore`. A transaction
  requesting `none`, performing follow, or recording a clamped remainder is
  exempt. Painted start alone is expected to remain unchanged only when the
  leading offset is unchanged. This assertion applies to geometric measurement
  anchors as well as consumer anchors.
- All reads for transaction `R` precede its commit, and the commit observes
  the same revision and surface generation.
- No more than one physical scroll write occurs.
- No physical write occurs while activity is `dragging` or `coasting` for
  `measurement` or `follow` provenance.
- Every physical write, including idle redemption, records ownership before
  the browser can dispatch its `scroll` event.
- Deferred navigation provenance is impossible.
- A range-preserving scroll produces zero snapshot publications.

## Measurement

### One observer and exact ownership

The DOM driver owns one `ResizeObserver` for the viewport and mounted item
elements. It never observes the sizer: Virt writes the sizer height itself,
and self-observation can create an undelivered-notification loop without
providing position information. Post-commit rect reads and explicit
`refreshLayout()` own sizer-position detection. An item entry is accepted only
when:

```ts
elementsByKey.get(key) === entry.target &&
	entry.target.isConnected &&
	geometry.indexOf(key) !== undefined;
```

Delayed entries for removed, replaced, or re-keyed elements are ignored. An
attachment for the same key may replace the old element synchronously; the old
element is unobserved before the new owner is registered.

### First mount

Attaching an uncached item queues one controller microtask after the Svelte
commit. The microtask:

- Collects every pending connected item.
- Reads every height before changing geometry or Svelte state.
- Applies the measurements as one transaction before the browser paints.
- Runs even while activity is `dragging` or `coasting`; iOS safety comes from
  visual deviation, not skipped measurement.

This intentionally differs from TanStack PR #1144. Estimates remain useful
for offscreen range prediction, but a mounted row does not knowingly paint one
frame at an avoidable estimate merely because the user is scrolling.

### Subsequent resize

Observer callbacks collect all entries first, then apply one measurement
transaction. Preferred size order:

```ts
function blockSize(entry: ResizeObserverEntry | undefined, element: HTMLElement): number {
	return Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
}
```

The standard `borderBoxSize` array supplies the vertical border-box size;
missing entries fall back to `offsetHeight`. Zero is retained as a valid size.
Nonfinite or negative values are rejected with a development diagnostic and
leave the prior size intact.

Publishing transforms does not resize the observed row's border box, avoiding
an observer feedback loop. Viewport entries schedule viewport-size work; no
self-caused sizer entry can schedule another transaction.

### Cached remount and content readiness

A surviving key keeps its last measurement. A cached remount may render from
that size immediately and remains observed. If the new wrapper reports the
same size, the observer transaction has zero correction.

Chat owns content readiness. When images, CodeMirror, syntax highlighting, or
`data-chat-layout-pending` make a target semantically unsettled, Chat continues
to wait before declaring navigation or initial reveal complete and calls
`remeasure(element)` when the content settles. Virt may measure intermediate
physical sizes; visual deviation prevents those corrections from moving an
unrelated reading anchor during iOS momentum.

The virtualizer cannot correct reflow inside the selected anchor row when the
reflow occurs above the exact inner content being read. Content renderers must
continue reserving predictable layout where possible. A later explicit inner
DOM-anchor protocol is a separate feature and must not be inferred from row
height alone.

## Svelte integration

`VirtualListController` is a rune-backed orchestration class, matching the
repository naming policy. It holds one raw snapshot:

```ts
const EMPTY_SNAPSHOT: VirtualListSnapshot = {
	revision: 0,
	visibleRange: null,
	overscanRange: null,
	sizerSize: 0,
	positions: EMPTY_POSITION_VIEW,
};

export class VirtualListController {
	#snapshot = $state.raw<VirtualListSnapshot>(EMPTY_SNAPSHOT);

	get snapshot(): VirtualListSnapshot {
		return this.#snapshot;
	}
}
```

The controller does not use a legacy readable/writable store and does not use
`$effect` to mirror derived values. DOM lifecycle lives in attachments.
No controller method calls `flushSync()` or `tick()`.

The chat shell reads a snapshot and derives retained items declaratively:

```svelte
<script lang="ts">
	import { virtualItems as selectVirtualItems } from '$lib/virt/virtual-list-types.js';

	const virtualSnapshot = $derived(virtualController.snapshot);
	const renderedIndexes = $derived(virtualController.renderedIndexes(virtualSnapshot));
	const virtualItems = $derived(selectVirtualItems(virtualSnapshot, renderedIndexes));
</script>

<div
	bind:this={virtualRoot}
	class="relative w-full"
	style:height={`${virtualSnapshot.sizerSize}px`}
	style="overflow-anchor: none;"
	data-chat-virtual-sizer
	data-chat-virtual-count={virtualItems.length}
	data-chat-virtual-model-count={projection.model.items.length}
	data-chat-virtual-data-revision={projection.projectedDataRevision}
	data-chat-transcript-entry-count={chatState.entries.length}
	data-chat-transcript-scale={String(textScale)}
	{@attach virtualController.sizer}
>
	{#each virtualItems as virtualItem (virtualItem.key)}
		<ConversationFeedVirtualRow {virtualItem} />
	{/each}
</div>
```

The physical scroll element receives `{@attach virtualController.viewport}`.
Each row renders the final coordinate and attaches by key:

```svelte
<div
	bind:this={wrapper}
	class="absolute inset-x-0 top-0 w-full"
	style:transform={`translateY(${virtualItem.start}px)`}
	data-index={virtualItem.index}
	data-chat-virtual-item={item.key}
	role="presentation"
	onfocusin={handleFocusIn}
	onfocusout={handleFocusOut}
	{@attach controller.item(virtualItem.key)}
>
	<!-- Existing svelte:boundary and row content remain unchanged. -->
</div>
```

The comment in the example represents unchanged existing markup, not a new
production comment requirement. `bind:this={virtualRoot}`, the listed sizer
and transcript attributes, row `data-index`, `data-chat-virtual-item`,
`role="presentation"`, focus handlers, and the row-level `<svelte:boundary>`
are a preserved DOM and accessibility contract. The Chromium suite and Chat
retention/target code consume them. During pending deviation,
`style.height` reports physical `sizerSize`, which equals logical total only
when deviation is zero.

The current `positionReadingAnchor(virtualItem)` row attachment is deleted at
cutover. It exists only to drive TanStack's pending-anchor settlement scroll;
Virt resolves the keyed anchor and viewport offset inside the ordered
transaction or `scrollToAnchor` without requiring the row to be mounted. Chat's
separate content-readiness/target settlement remains as documented.

### Geometry publication ordering

`ConversationFeed` keeps the existing `$effect.pre` publication point but
replaces prepare-plus-later-adapter-repair with one synchronous mutation:

```ts
$effect.pre(() => {
	const input = projectionInput;
	untrack(() => {
		const nextProjection = projectionState.reconcile(input);
		const applied = virtualController.applyProjection({
			previous: projection,
			next: nextProjection,
			pinned: pinnedToBottom,
			retainedKeys: retention.retainedKeys,
		});
		if (applied) projection = nextProjection;
	});
});
```

`applyProjection` is a Chat adapter method, not a Virt method. It selects the
semantic anchor and converts `ConversationVirtualGeometrySnapshot` into the
appropriate `VirtualItemsMutation`; it returns true only when Virt accepts the
mutation. Both the Virt snapshot and Chat projection
therefore become pending Svelte state in the same pre-effect call stack. A
rejected Virt mutation retains both the prior Virt snapshot and Chat
projection. In this pre-effect path the commit microtask is queued from inside
the active Svelte flush; render effects commit later in the same synchronous
flush before that microtask runs. Newly mounted rows are measured by the
separate mount transaction after this commit; they are never synchronously
read from the pre-effect.

The sample changes only geometry publication. The surrounding
`itemState.reconcile(...)`, `pendingPermissionOccurrences`, per-index model
lookup, `{@const item ...}`, and `{#if item}` guard remain unchanged; Virt does
not replace feed-item state or malformed-model containment.

On `replace-surface`, `applyProjection` immediately follows the replacement
mutation with Chat's chosen initial anchor or end target. The replacement
itself remains not-ready and ignores clamp-driven scroll events; the target
publishes the initialized snapshot and owns the first post-commit write.

## Chat adapter migration

`ConversationFeedVirtualController` remains the implementation of
`ConversationViewportPort` and becomes a smaller Chat policy adapter around
`VirtualListController`.

Projection mapping is explicit:

```text
restore-if-pinned + currently pinned  -> anchor: end, provenance: follow
restore-if-pinned + not pinned         -> semantic item anchor
preserve-reading-position              -> semantic item anchor
explicit-navigation                    -> anchor: none, then navigation target
surface identity changed               -> replace-surface, then initial target
```

The viewport port gains one provider-neutral coordinate query:

```ts
export interface ConversationViewportPosition {
	readonly logicalOffset: number;
	readonly distanceFromStart: number;
	readonly leadingContentReachable: boolean;
}

export interface ConversationViewportPort {
	// Existing methods remain.
	viewportPosition(): ConversationViewportPosition | null;
}
```

`ConversationFeedVirtualController` maps this from Virt's
`viewportPosition` and delegates `ownsScrollPosition()` directly to Virt's
getter. Inside that adapter, semantic reading-anchor selection and hidden
viewport-offset capture read Virt's full position and pair its `paintedOffset`
with `positions.itemAtOffset()`. The narrower `ConversationViewportPosition`
returned through the port contains only the logical fields consumed by
`ConversationScrollController`.
`ConversationScrollController` renames its previous physical offset to a
previous logical offset and uses the query for direction inference,
`#syncViewportStart`, and earlier-page proximity. Earlier proximity requires
both `leadingContentReachable` and
`distanceFromStart <= pagePrefetchDistance(...)`; a successful prepend cannot
re-arm paging while its leading rows remain behind the deviation wall.
Constructor initialization also uses the query instead of physical
`scrollTop`. A `null` position leaves the default start state unchanged and
cannot trigger paging until the attached viewport publishes a position. Every
post-target, visibility, and operation-boundary reset of the previous offset
also reads `logicalOffset`; no intent path retains a physical `scrollTop`
fallback.

The adapter also retires its two start-side physical checks:
`prepareForGeometryPublication(...).beginMountedRowRetention` and
`ConversationEarlierPrependAnchorOwnership.preserves(...)` consume logical start
proximity instead of raw `scrollTop`. Paging requires
`leadingContentReachable && distanceFromStart <= threshold`; preservation of
an already-owning prepend treats either an unreachable leading page or logical
distance within the threshold as clamped. This keeps pending deviation from
looking like a fresh physical-top paging opportunity without allowing user
reversal to cancel the owning prepend incorrectly.
If `viewportPosition` is `null`, both migrated checks treat the publication as
not clamped and acquire no new start-boundary ownership, matching the current
`Number.POSITIVE_INFINITY` fallback.

The scroll handler checks `ownsScrollPosition()` before inferring or applying
user direction. Every Virt write, including idle deviation redemption, marks
that ownership synchronously before assigning `scrollTop` and retains it
through the post-write animation frame, after every same-target scroll listener
has run. An authored redemption can therefore update the stored logical offset
but can never become user direction or cancel a page mutation.
This is a deliberate reorder from the current handler, which infers direction
before its ownership check; preserving that order would violate the new port
contract.

The first row is the streaming hot path. It must defer like measurement while
activity is `dragging` or `coasting`; treating it as ordinary programmatic
scroll would reproduce the iOS momentum interruption. The adapter also exposes
`measurementAnchor: 'end'` only while `restore-if-pinned` remains active and
the surface is currently pinned; otherwise it exposes `geometric`. This keeps
later streaming-row and first-mount measurements in the same policy
transaction as the append that caused them.

It continues to own:

- Translating Chat geometry mutation kinds into `update`,
  `reset-measurements`, or `replace-surface`.
- Selecting transcript-preferred anchors and fallback keys.
- Earlier-prepend ownership and mounted-row retention.
- Hidden reading-anchor/offset capture and restoration.
- Initial end reveal policy.
- Target readiness for images and `data-chat-layout-pending`.
- Paging fill classification.
- Notifying Virt when Chat-owned toolbar, empty-state, or composer-reservation
  layout can move the sizer without resizing it.
- User-intent cancellation semantics exposed through the viewport port.
- Logical viewport position and leading-content reachability exposed through
  the viewport port for paging and direction policy.
- Focus and transient retention integration.

Virt takes over:

- TanStack construction, stores, options, subscription, `setOptions`, and
  `rangeExtractor` plumbing.
- Item measurement ingress and stale observer rejection.
- `scrollMargin` and manual `start - scrollMargin` conversion.
- Keyed size cache, range, total size, and offset lookup.
- Measurement-induced anchor correction.
- Touch-deferred painted deviation and its cancellation semantics.
- Low-level programmatic scroll ownership and all direct physical writes.
- The current Chat-local `ConversationProgrammaticScrollOwnership`; the port
  delegates ownership to Virt so two ownership clocks cannot diverge.

The migration must not promise deletion of every current convergence loop.
`settleConversationTarget` waits for content readiness, not only virtualizer
geometry, and remains until an equivalent content signal replaces it. Initial
reveal may still require a bounded paint gate. Each loop is evaluated by what
it waits for; only loops that repair TanStack ordering are deleted.

## Failure handling

| Failure                                                 | Required behavior                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Duplicate source key                                    | Return `rejected`, retain prior geometry/projection, and emit a diagnostic; development may throw after recording.                                                                               |
| Key/estimate length mismatch                            | Return `rejected`, retain prior geometry/projection, and emit a diagnostic; development may throw after recording.                                                                               |
| Negative or nonfinite estimate                          | Return `rejected`, retain prior geometry/projection, and emit a diagnostic; development may throw after recording.                                                                               |
| Stale observer target                                   | Ignore and record a development diagnostic.                                                                                                                                                      |
| Anchor removed by mutation                              | Apply without correction; report missing anchor in instrumentation.                                                                                                                              |
| Measurement target detached                             | Ignore.                                                                                                                                                                                          |
| Measurement is zero                                     | Accept as valid geometry.                                                                                                                                                                        |
| Measurement is negative/nonfinite                       | Ignore and retain prior size.                                                                                                                                                                    |
| Programmatic target before viewport initialization      | Return `not-ready`; perform no write.                                                                                                                                                            |
| Key or index target outside geometry                    | Return its specific typed missing result; perform no write.                                                                                                                                      |
| Browser clamps a valid target                           | Reconcile to the attained offset; never loop without a fixed budget.                                                                                                                             |
| Browser clamps without a Virt write after bounds change | Solve deviation from the clamped prior logical target and attained physical offset; record any impossible remainder before publishing.                                                           |
| Scroll request with pending deviation                   | Publish final zero-deviation geometry and perform one resolved target write.                                                                                                                     |
| Cancellation with pending deviation                     | Cancel owned work; retain deviation until safe redemption.                                                                                                                                       |
| Positive deviation hides prepended leading content      | Report it unreachable; suppress another earlier request and redeem on the first in-bounds idle turn after top bounce.                                                                            |
| Negative redemption would cross physical top            | Wait for the first idle in-bounds opportunity; if settled at top, apply and record the bounded clamped remainder.                                                                                |
| Surface replacement with pending deviation              | Clear old deviation, measurements, elements, and attachments; ignore clamp events until the first explicit target.                                                                               |
| `apply()` while suspended                               | Update/prune source geometry without correction or range publication; preserve same-surface deviation.                                                                                           |
| `resume(target)` after hidden updates                   | Publish only zero-deviation current keys and geometry, resolve one target atomically, and never expose the stale pre-suspension snapshot; a missing key returns after publication with no write. |
| Leading offset changes without resize                   | Fold its delta into the selected anchor correction before any write.                                                                                                                             |
| Elastic touch offset                                    | Defer physical write until offset is in bounds and activity is idle.                                                                                                                             |
| Controller destroyed twice                              | Idempotent cleanup; no observed nodes, listeners, timers, or pending callbacks remain.                                                                                                           |
| Observer callback after destroy                         | Ignore by destroyed generation.                                                                                                                                                                  |
| Deferred deviation remains idle for one second          | Emit diagnostic and attempt redemption.                                                                                                                                                          |

Errors in item renderers remain isolated by the existing row-level
`<svelte:boundary>` and do not enter Virt.

## Instrumentation and observability

Development builds keep a bounded ring buffer of transaction records:

Target: `web/src/lib/virt/virtual-list-types.ts`

```ts
export interface VirtualTransactionRecord {
	readonly revision: number;
	readonly source:
		'items' | 'mount' | 'resize' | 'viewport' | 'resume' | 'programmatic' | 'replace-surface';
	readonly provenance: 'measurement' | 'follow' | 'navigation' | null;
	readonly activity: VirtualScrollActivity;
	readonly anchorKind: 'item' | 'end' | 'none';
	readonly anchorIndex: number | null;
	readonly anchorPaintedStartBefore: number | null;
	readonly anchorPaintedStartAfter: number | null;
	readonly changedCount: number;
	readonly firstChangedIndex: number | null;
	readonly correction: number;
	readonly scrollTopBefore: number;
	readonly intendedScrollTop: number;
	readonly attainedScrollTop: number;
	readonly leadingOffsetBefore: number;
	readonly leadingOffsetAfter: number;
	readonly deviationBefore: number;
	readonly deviationAfter: number;
	readonly redeemed: boolean;
	readonly clampedRemainder: number;
	readonly published: boolean;
	readonly scrollWrites: number;
	readonly durationMs: number;
	readonly ignoredEntries: number;
}
```

`intendedScrollTop` equals `scrollTopBefore` when the transaction plans no
write. `attainedScrollTop` is updated by the matching event or post-write frame
before the record is finalized. The anchor start fields plus these offsets
support the viewport-coordinate assertion without logging content or keys.

The Chat test host may expose this buffer through a test-only accessor.
Production builds do not attach undocumented state to `window`. If physical
iOS debugging requires a browser hook, add it only in development mode behind
an explicit exported diagnostic installer; the core should remain independent
of global names.

No transaction record includes transcript text, raw key values, user
identifiers, or DOM serialization. Real transcript fixtures or excerpts are
forbidden.

## Performance budgets

- Pure geometry transaction at 20,000 rows, including source diff, key-map
  writes, prefix work, and revision-scoped position-view publication: less than
  1 ms p95 on the CI baseline for tail append and streaming-tail measurement.
- Deviation-only position-view publication is `O(1)` over shared logical
  arrays plus one scalar; it never copies every row.
- Complete DOM/geometry transaction at 20,000 logical rows with the normal
  rendered window: less than 2 ms p95 excluding consumer content layout.
- Tail append performs map writes proportional to appended keys and one prefix
  rebuild from the first changed index; it never reconstructs the full map.
- At most one prefix rebuild per transaction.
- At most one physical scroll write per transaction.
- One shared observer per controller, not one observer per row.
- Every production file remains at or below the mechanically enforced
  1,000-line architecture budget.
- Virt production core remains at most 1,800 lines total.
  This is the single normative Virt line budget and stop threshold. The
  planning targets below sum to 1,500 lines and leave 300 lines of contingency;
  they guide responsibility splits but are not independent hard caps.
- The migrated transcript controller/runtime/viewport-geometry total must be
  at most 1,400 lines, down from the target-baseline
  `979 + 703 + 212 = 1,894`, rather than preserving every TanStack repair path
  around a second engine.
- `ConversationScrollController` plus the extracted logical-position helper
  must total at most 1,050 lines, with each file at or below the repository's
  1,000-line limit. Combined with the 1,400-line transcript adapter budget,
  the migrated Chat virtualization/scroll boundary is at most 2,450 lines,
  down from the target-baseline `1,894 + 992 = 2,886`.

| Virt module                         | Planning target |
| ----------------------------------- | --------------- |
| `virtual-list-types.ts`             | 150 lines       |
| `virtual-list-geometry.ts`          | 300 lines       |
| `virtual-scroll-deviation.ts`       | 150 lines       |
| `virtual-list-environment.ts`       | 80 lines        |
| `virtual-list-transaction.ts`       | 350 lines       |
| `virtual-list-dom-driver.ts`        | 300 lines       |
| `virtual-list-controller.svelte.ts` | 170 lines       |

Performance tests report distributions rather than asserting microsecond wall
times in ordinary unit CI. Deterministic operation-count assertions enforce
incremental map writes, one rebuild, logarithmic lookup, bounded visible walk,
and one write. If prefix/suffix diffing cannot meet the 20,000-row geometry
budget, implementation stops before the Svelte driver is built.

## Accessibility and browser behavior

- Existing stable keyed `{#each}` rendering remains, preserving DOM identity
  for mounted rows.
- Focused and selected rows remain explicitly retained by Chat policy.
- `role="presentation"` and row-level semantic content remain unchanged.
- Keyboard target navigation continues through `ConversationViewportPort`.
- Native browser scroll anchoring remains disabled with
  `overflow-anchor: none`; explicit Virt anchoring is the sole correction
  system.
- Browser find-in-page and selection across unmounted rows retain the current
  virtualization limitations. Extraction does not expand this scope.
- Chromium, Firefox, and desktop WebKit must agree on range, sizer, and
  programmatic target behavior.
- Desktop Playwright WebKit does not validate iOS touch momentum or elastic
  scrolling and must not be described as doing so.

## Security, privacy, and compatibility

Virt processes only consumer-provided keys, numeric estimates, element
references, and scroll geometry. It performs no network, storage, HTML parsing,
or transcript serialization.

Keys may contain user-derived durable identities in production, so
transaction instrumentation never records raw key strings. Tests and durable
fixtures use synthetic deterministic keys and content.

Server and client ship together; no backward-compatible runtime API or dual
protocol is required. The rollback boundary is a source revert, not a
permanent compatibility mode.

Virt contains no copied or closely adapted third-party implementation. The
measurement helper independently implements standard `ResizeObserver` and
layout APIs; its pinned source comment records why its deliberate rounding and
fallback semantics match TanStack Virtual. Algorithmic prior art does not
require a copied license notice. No code may be copied from the commercial
React Virtuoso Message List implementation.

### Implementation provenance

Implement independently:

- The prefix geometry and incremental key diff.
- The item/geometric anchor rules and leading-offset correction.
- The deviation reducer and provenance contract.
- The Svelte 5 controller, attachments, snapshot, and commit barrier.

The following TanStack behaviors informed tests and semantic comparison, but
their implementation was not transcribed:

- TanStack's `borderBoxSize` → rounded CSS pixel → cached value →
  `offsetHeight` measurement order from
  [`virtual-core/src/index.ts#L244-L285`](https://github.com/TanStack/virtual/blob/e9874f033c74afd3251eeb9f3e60b2530cc7ae88/packages/virtual-core/src/index.ts#L244-L285).
- TanStack's intended-subpixel reconciliation against integer-rounded WebKit
  readback from
  [`virtual-core/src/index.ts#L832-L888`](https://github.com/TanStack/virtual/blob/e9874f033c74afd3251eeb9f3e60b2530cc7ae88/packages/virtual-core/src/index.ts#L832-L888).
- TanStack's elastic-overscroll bounds guard if its exact control flow is
  retained rather than independently rederived.

`Math.round(blockSize)` is deliberate and matches the pinned TanStack default;
it is not an accidental loss of subpixel row size. React Virtuoso's deviation
system informs the coordinate model, but Virt uses the public concept rather
than its `urx` implementation. React Virtuoso Message List documentation is
contract evidence only; its commercial implementation is never transcribed.

## Alternatives

### Keep TanStack and the patch

This remains the lowest-risk short-term fallback. The patch itself is only 159
lines. It does not solve the architectural split or give Garcon a painted
deviation transaction. Keep this option genuinely open if the custom core
fails its complexity or iOS gates.

### Fork or vendor TanStack

Rejected. It makes Garcon responsible for a larger generalized core and its
unused modes without changing the design that produced the ownership split.
Maintaining the existing patch is preferable to maintaining a fork.

### Adopt Virtua

Rejected. It offers first-party Svelte components and a framework-neutral
core, but reverse infinite scrolling still has acknowledged correction
glitches. Garcon would rewrite all integrations while retaining custom
semantic anchor, retention, provenance, and cancellation logic.

### Adopt React Virtuoso Message List

Rejected. It is React-specific and commercially licensed. Its public contract
and the MIT open list's deviation mechanism remain useful prior art.

### Use native CSS scroll anchoring

Rejected. Native anchoring cannot express pinned streaming, history prepend,
conversation replacement, retained unmounted targets, or user-intent
cancellation. It may also be suppressed during programmatic scrolls. Combining
it with explicit correction creates nondeterministic dual ownership.

### Render normal flow with top and bottom spacers

Deferred. Normal-flow layout makes browser anchoring and reflow participate in
every size change. Absolute rows make item position a pure geometry function
and preserve the current rendering model. A normal-flow experiment requires
separate evidence and browser coverage.

### Fenwick tree or size-run tree

Rejected for v1. Current scale and preliminary measurement favor simple typed
arrays. The design records a measurable escalation trigger.

## Implementation history

The implementation landed in the following independently revertible slices.
The validation commands remain as the release record for each boundary.

### Establish the pure contract

Add:

- `web/src/lib/virt/virtual-list-types.ts`
- `web/src/lib/virt/virtual-list-geometry.ts`
- `web/src/lib/virt/virtual-scroll-deviation.ts`
- Pure tests under `web/src/lib/virt/__tests__/`

Implement key validation, incremental prefix/suffix source diffing,
capacity-doubling arrays, measurement cache, zero-height-safe range lookup,
revision-scoped position views, and deviation transitions. Keep
`VirtualScrollActivity` as a type only; Chat remains the touch-settlement
owner. No production consumer changes.

Record pinned prior art beside any deliberately matched behavior. Introduce a
third-party notice only if implementation text is later copied or closely
adapted.

The deviation reducer remains a pure state transition:

```ts
export interface VirtualDeviationState {
	readonly value: number;
	readonly pendingSince: number | null;
}

export type VirtualDeviationDecision =
	| { readonly kind: 'settled'; readonly state: VirtualDeviationState }
	| { readonly kind: 'deferred'; readonly state: VirtualDeviationState }
	| {
			readonly kind: 'redeem';
			readonly amount: number;
			readonly state: VirtualDeviationState;
	  };

export function applyVirtualCorrection(input: {
	readonly current: VirtualDeviationState;
	readonly correction: number;
	readonly activity: VirtualScrollActivity;
	readonly provenance: 'measurement' | 'follow' | 'navigation';
	readonly inPhysicalBounds: boolean;
	readonly now: number;
}): VirtualDeviationDecision;
```

Validate with:

```bash
bun run --cwd web test -- src/lib/virt/__tests__/virtual-list-geometry.logic.test.ts \
	 src/lib/virt/__tests__/virtual-list-geometry-property.logic.test.ts \
	 src/lib/virt/__tests__/virtual-scroll-deviation.logic.test.ts
```

Rollback: delete the additive modules. No production path changes.

### Build the Svelte driver against a deterministic DOM harness

Add `virtual-list-controller.svelte.ts`, `virtual-list-transaction.ts`,
`virtual-list-dom-driver.ts`, and the environment port. The controller remains
the small public rune-backed facade; the transaction module owns
transaction/commit/redemption; the DOM driver owns attachments, one
viewport/item observer, mount batching, listeners, physical reads/writes, and
teardown. This split is part of the initial implementation, not cleanup after
a file crosses the architecture budget.

Reuse the existing `installResizeObserverHarness` through a test-to-test import
or add a Virt-local observer double. Do not move it into production
`src/lib/testing/`. The Virt harness combines the observer double with its
injected environment and real happy-dom element properties. It must provide:

- Manual observer delivery.
- Scriptable `scrollTop`, `scrollHeight`, client height, and elastic offsets.
- Scriptable viewport and sizer `getBoundingClientRect()` results.
- Scriptable microtasks and animation frames.
- Scroll-write capture.
- Connected/replaced/detached element ownership.
- Post-commit sizer publication and both authored and unsolicited
  browser-clamp simulation.

Synchronize dependencies first and verify that installed Svelte matches the
lockfile's 5.56.10 before trusting scheduling behavior. No harness test may
assert that `flushSync()` called from inside an effect exposes that effect's
committed DOM. Tests may call `flushSync()` outside effects to drive a
deterministic Svelte commit.

Port the local patch contracts and upstream regression history into direct
controller invariants before wiring Chat.

Validate with:

```bash
bun run --cwd web test -- src/lib/virt/__tests__/virtual-list-controller.test.ts
bun run check
```

Rollback: delete the unwired controller and tests.

### Replay transcript geometry offline

Build deterministic sequences from synthetic versions of the existing
Chromium scenarios:

- Initial bottom reveal.
- Earlier page prepend.
- Compact and wide touch prepend.
- Interrupted compact touch prepend.
- Scrollbar and keyboard reversal.
- Tool-pair completion.
- Text-scale reset.
- Chat switch and held earlier page.
- Detached live following.

Run static source geometry through TanStack and Virt and compare keys, logical
positions, total size, and base range where their contracts should match.
Do not compare correction decisions that Virt intentionally changes. Do not
mount two live controllers against one viewport.

Rollback: delete the offline replay fixtures.

### Rewire the transcript in one revertible change

Update the complete transcript boundary:

- `ConversationFeed.svelte`
- `ConversationFeedVirtualRow.svelte`
- `ConversationFeedVirtualController.svelte.ts`
- `conversation-feed-virtual-runtime.ts`
- `conversation-feed-viewport-geometry.ts`
- `conversation-feed-viewport-geometry.logic.test.ts`
- `ConversationFeedVirtualControllerTestHost.svelte`
- `ConversationFeedVirtualController.test.ts`
- `tanstack-virtual-core-patch.test.ts`
- `web/src/lib/chat/transcript/conversation-viewport-port.ts`
- `web/src/lib/chat/transcript/conversation-scroll-controller.svelte.ts`
- `web/src/lib/chat/transcript/conversation-scroll-position.ts`
- `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller-effect-harness.svelte.ts`
- `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller.test.ts`
- `web/src/lib/chat/transcript/__tests__/conversation-scroll-position.logic.test.ts`

Extend `ConversationViewportPort` with the documented provider-neutral logical
viewport query and update every caller and test double in the same change.

`conversation-scroll-controller.svelte.ts` was 992 lines at the target
baseline under the same newline-count metric as the 1,000-line architecture
test. Before adding the port integration, the migration extracted logical
direction inference, start detection, and page-boundary proximity into
`conversation-scroll-position.ts`. The helper is DOM-free and port-free: it
accepts `ConversationViewportPosition`, thresholds, and the already-evaluated
`isAtEnd(distance)` boolean needed by the later boundary. The controller
delegates to it; no grandfather entry was added. The controller/helper pair is
included in the documented 1,050-line and combined 2,450-line migration
budgets.

Replace TanStack store reads with the Virt snapshot, attach the physical
viewport/sizer/items, render `virtualItem.start` directly, and forward native
scroll activity. Delete only repair paths made unnecessary by transaction
ownership. Replace TanStack `Range`, `Rect`, `defaultRangeExtractor`,
`scrollMargin`, and `totalSize` assumptions with the inclusive Virt range and
painted-coordinate contracts. Preserve content-settlement, DOM attributes,
and product-policy loops.

The obsolete TanStack viewport-rect adapter is removed.
`isConversationVirtualViewportCovered` uses the physical `sizerSize` and
painted coordinates; it must not compare pending deviation against a hidden
logical total or subtract the retired `scrollMargin`.
`classifyMeasuredConversationViewportFill` removes TanStack's
"rendered without a cache entry means measured at its estimate" fallback,
because Virt's first-mount batch measures every mounted row. Its `leadingSize`
input is removed or renamed around the new `leadingOffset` meaning rather than
retaining `scrollMargin` semantics. The existing logic test is rewritten
around those meanings.

The cutover is one revertible commit after the additive core commits. There is
no live runtime switch and no dual scroll writer.

Validation:

```bash
bun run check
bun run test
bun run build
cd integration-tests
bun ../scripts/run-test-files.js \
	'tests/chromium/transcript-virtualization.test.ts' \
	--max-concurrency=1 --timeout=120000
cd ..
timeout 30s bun run start --port 0
```

The full Chromium lane is `bun run test:integration:chromium`. The transcript
virtualization file passes with all existing assertions intact; no assertion
is relaxed to accommodate movement.

Rollback: revert the transcript cutover commit. Additive Virt modules may
remain unwired for continued investigation or be reverted separately.

### Remove the chat patch dependency

After Chat moved to Virt, the migration:

- Replaced `tanstack-virtual-core-patch.test.ts` with Virt invariant tests.
- Removed the root Bun patch entry and patch file.
- Removed the direct `@tanstack/virtual-core` dependency.
- Temporarily retained `@tanstack/svelte-virtual` for the five remaining
  surfaces.
- Regenerated `bun.lock` through Bun.

Every remaining TanStack surface was validated before the patch was removed
because the transitive core became unpatched.

Rollback: restore the patch mapping while investigating any unrelated-surface
regression.

### Migrate ordinary surfaces independently

The remaining surfaces migrated independently:

- File tree.
- Git commit list.
- Git diff viewport.
- Git changed-file tree.
- Sidebar sortable chat list.

Each migration preserved its own focus/selection anchor policy and gained
surface-specific tests.

After the final consumer migrated, the branch:

- Removed `@tanstack/svelte-virtual`.
- Removed TanStack Virtual from the Vite `vendor-dnd` chunk rule.
- Regenerated the lockfile and compared production bundle output.
- Left `fixed-virtual-window.svelte.ts` independent.

### Evaluate package extraction

Extraction becomes a separate design and repository decision after:

- Chat and at least two non-chat surfaces use the same core API without
  Garcon-specific branches in `virt`.
- Physical iPhone validation has passed across at least two releases.
- Transaction diagnostics show no unresolved deviation or correction class.
- The core stays within its line and performance budgets.
- The API has required no compatibility aliases during internal migration.
- Prior-art provenance remains documented beside deliberately matched
  behavior.

Likely package boundaries:

```text
@garcon/virt-core     types, geometry, deviation
@garcon/virt-svelte   controller and attachments
```

Those names are illustrative. No workspace package, build output, semantic
versioning policy, documentation site, or external compatibility promise is
part of this implementation.

## Test plan

### Pure geometry

Target: `web/src/lib/virt/__tests__/virtual-list-geometry.logic.test.ts`

Cases:

- Empty source.
- Unique key and estimate validation.
- Exact prefix positions and total size.
- Measurement replacing estimate.
- Surviving keyed measurement across prepend and append.
- Removed-key pruning.
- Measurement reset.
- Surface replacement.
- Fractional sizes.
- Zero-height rows and repeated offsets.
- Offset lookup at exact boundaries.
- Painted `VirtualPositionView.itemAtOffset()` lookup with positive and
  negative deviation.
- Viewport beyond either edge.
- Overscan clamp.
- 20,000-row construction and update operation counts: a one-row tail append
  performs one new index-map write, no surviving-key map writes, no array
  reallocation with spare capacity, and one prefix rebuild from the appended
  index; prepend explicitly shifts surviving map indexes.
- A deviation-only snapshot publication performs no per-row copy or geometry
  rebuild.

Representative assertion:

```ts
it('retains keyed sizes through prepend', () => {
	const geometry = new VirtualListGeometry();
	geometry.setItems(['b', 'c'], [40, 40]);
	geometry.measure('b', 64);
	geometry.setItems(['a', 'b', 'c'], [32, 40, 40]);

	expect(geometry.item(1)).toMatchObject({ key: 'b', start: 32, size: 64 });
	expect(geometry.totalSize()).toBe(136);
});
```

### Property tests

Target: `virtual-list-geometry-property.logic.test.ts`

Use deterministic seeded generation, not a new dependency unless the existing
test stack already provides one. Generate sequences of append, prepend,
remove, reset, estimate change, measurement, and zero-size measurement.
Compare every item, total, offset lookup, and range with a naive linear
reference after each operation. Failure output includes only the seed and
synthetic numeric/key operations.

### Deviation state

Target: `virtual-scroll-deviation.logic.test.ts`

Table dimensions:

- Idle, dragging, and coasting.
- Measurement, follow, and navigation provenance.
- Positive, negative, zero, and accumulated corrections.
- In-bounds redemption, negative top-clamp, and elastic overscroll.
- Cancellation, idle redemption, and surface reset.
- Absolute target while deviation is pending.
- Idle liveness diagnostic.

Assertions include:

- Idle measurement and follow request redemption.
- Dragging/coasting measurement and follow never request a physical write.
- Navigation never defers.
- Cancellation preserves deviation.
- Surface replacement clears deviation without redemption.
- Exact redemption amount equals accumulated deviation.
- A negative top-boundary redemption reports the clamped remainder.

The existing
`web/src/lib/chat/transcript/__tests__/conversation-native-scroll-settlement.logic.test.ts`
continues to own touch start, movement, coasting extension, idle delay,
cancellation, multi-touch identity, and gesture direction. Virt tests consume
explicit activity values and do not duplicate that classifier.

### DOM controller

Target: `virtual-list-controller.test.ts`

The regression inventory is traceable rather than summarized as “patch
parity”:

| Evidence                 | Virt invariant                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Bun stale-entry hunk     | Direct same-key element replacement is accepted; a delayed entry from the replaced element is rejected. |
| Bun backward-shrink hunk | Above-anchor shrink is fully compensated independent of scroll direction.                               |
| Bun cancellation hunk    | Cancellation invalidates delayed commits while preserving painted deviation.                            |
| TanStack #1176           | Prepend updates intended physical coordinates in the same logical transaction.                          |
| TanStack #1199           | First measurement above the anchor while moving backward preserves the anchor.                          |
| TanStack #1209           | A clamped write records the attained offset, not the impossible target.                                 |
| TanStack #1212           | Repeated above-anchor resizes accumulate against current geometry.                                      |
| TanStack #1236           | Growth of a viewport-spanning anchor row does not move its top.                                         |
| TanStack #1239           | Published range/position state is current before consumers observe correction completion.               |

Cases:

- Attach/detach viewport, sizer, and items; the observer observes viewport and
  items but never the self-sized sizer.
- Idempotent destroy and observer cleanup.
- Direct element replacement for one key.
- Delayed stale observer entry rejection.
- Batched uncached mount reads before all writes.
- First mount measured during dragging without a physical write.
- One prefix rebuild and one publication per observer batch.
- Measurement transaction selects the first visually intersecting item as its
  geometric anchor.
- Above-anchor growth and shrink.
- Backward-scroll shrink.
- Viewport-spanning anchor-row growth.
- Repeated measurement before the browser scroll event.
- Prepend publishes the grown sizer before its post-commit write; a stale
  pre-commit `scrollHeight` cannot clamp the target.
- Painted deviation and no-jump redemption.
- Negative deviation at the physical top records its bounded clamped
  remainder.
- Mutation-driven end follow defers during dragging/coasting and redeems when
  idle.
- A measured streaming-tail growth uses consumer-owned end follow while pinned
  and the geometric anchor after the consumer detaches.
- Pending deviation plus absolute target uses one physical write.
- Cancellation retains deviation.
- Leading-offset movement preserves the selected anchor even when neither
  viewport nor sizer resizes.
- A viewport-height change that causes an unowned browser clamp while
  deviation is pending solves the representable logical target before
  publication and records any impossible remainder without a correction loop.
- Range-preserving viewport scroll produces zero publications.
- Positive deviation culls fully negative base-overscan items while an
  explicitly retained focused item remains mounted.
- Surface replacement discards old ownership, attachments, and deviation and
  ignores clamp-driven scroll events until the explicit target.
- WebKit integer/subpixel readback.
- A matching owned scroll event records its offset but every same-target
  consumer listener still observes ownership; the post-write frame clears it.
- A clamped or no-op owned write that emits no scroll event uses the same
  frame cleanup; the next user movement is not swallowed.
- Elastic top and bottom overscroll.
- Zero-height mounted item.
- Cached remount with unchanged size produces no correction.
- `suspend`, `resume`, and destroy invalidate pending callbacks.
- Hidden item updates followed by `resume(target)` publish only current keys
  and target them in the same operation; no stale snapshot becomes visible.
- `resume(target)` with pending deviation publishes zero-deviation geometry
  and performs exactly one resolved navigation write.

The harness records each operation as `read`, `publish`, `commit`, or `write`.
It proves that a commit observes the published sizer and matching revision,
that all reads precede the write, and that no Virt method calls `flushSync`.

### Chat unit and component tests

Add `conversation-scroll-position.logic.test.ts` for previous/current logical
direction, null positions, start thresholds, unreachable leading content, and
earlier/later boundary predicates, including the already-evaluated later
`isAtEnd` input. The test is DOM-free and exercises the helper extracted from
the near-budget controller.

Update `ConversationFeedVirtualController.test.ts` to preserve product policy
coverage while removing TanStack mocks. Retain exact cases for:

- Pre-commit semantic anchor selection.
- Directionless gesture state.
- Mounted-row retention for an owning prepend.
- Clamped scrollbar-drag prepend.
- User cancellation after publication.
- Retained but unmounted anchor target.
- Visible and hidden text-scale reset.
- Show-time concurrent geometry.
- Surface identity replacement.
- Clamp-driven scroll events ignored between replacement and its first target.
- Logical offset drives direction, start state, and earlier-boundary proximity;
  physical zero with unreachable leading content does not request another
  page.
- Mounted-row retention and earlier-prepend preservation use the documented
  logical clamped predicate; neither reads physical `scrollTop`.
- Idle redemption is owned before direction inference and cannot become user
  intent.
- Initial reveal and end restore.
- `restore-if-pinned` streaming while coasting produces no physical write.
- Leading-offset change preserves the reading anchor.
- Hidden reading-anchor restoration.
- Target navigation and content readiness.
- Preserved sizer/row DOM attributes, role, and focus retention handlers.
- Complete cleanup.

Tests that formerly assert TanStack calls instead assert Virt transaction
records, published coordinates, physical writes, and viewport ownership.

### Chromium acceptance

`integration-tests/tests/chromium/transcript-virtualization.test.ts` remains
the acceptance suite and passes without weaker tolerances. It covers:

- Paging, append, and scale geometry.
- Earlier prefetch during active processing.
- Compact/wide touch and momentum prepend.
- Compact paused/interrupted prepend.
- Scrollbar and keyboard reversal.
- Navigation and user cancellation.
- Chat switch and held earlier page isolation.
- Native-history replacement and stale held page rejection.
- Tool-pair completion.
- Detached/live following.
- Expanded transcript retention beyond the retired prune interval.

Add a deterministic interleaving test for every production or live-suite
failure. A retry count or relaxed movement tolerance is not a fix.

Add one Chromium case using the existing `beginTranscriptTouchDrag`,
`moveTranscriptTouch`, and `finishTranscriptTouchDrag` helpers. Install a
page-local write trap on the transcript viewport, enter coasting, deliver a
pinned streaming append and an earlier prepend, and assert zero owned
`scrollTop` assignments until settlement. Restore the descriptor in test
cleanup. This automates the central no-write contract without claiming to
emulate physical iOS momentum or adding a production `window` hook.

### Browser and physical-device matrix

- Chromium: automated full transcript suite.
- Firefox: automated core transcript paging, prepend, and target navigation.
- Desktop WebKit: automated layout, measurement, rounding, and programmatic
  targeting.
- Physical iPhone Safari: required manual gate for touch momentum and elastic
  scrolling.

Physical iPhone checklist:

- Fling through an earlier-page prepend: the old reading row does not move,
  at most one earlier request is issued while leading content is unreachable,
  and the new page becomes reachable after settlement.
- Reach physical top with positive pending deviation: no write occurs during
  drag, coasting, or elastic bounce; redemption occurs on the first in-bounds
  idle turn and does not visibly move the old anchor.
- Shrink above the viewport while coasting toward the top.
- Rubber-band at top and end.
- Dismiss the software keyboard while deviation is pending and verify any
  viewport clamp is bounded, recorded, and does not loop.
- Stream while pinned.
- Stream while reading earlier content.
- Mount and expand long tool/code rows during a fling.
- Change scale while detached from the end.
- Navigate to an unmounted target mid-fling.
- Switch chats and replace the transcript mid-fling.
- Return to a cached chat and page earlier again.

Record device model, iOS version, browser, and result in the cutover PR. Do not
record transcript content.

## Rollout and rollback

There is no server migration or compatibility window. The client bundle ships
with one virtualization engine for the migrated surfaces. The pure core landed
additively, the transcript cutover landed as a revertible boundary, and the
ordinary surfaces migrated independently before the TanStack dependencies and
patch were removed.

Physical iPhone validation remains the release gate for momentum and elastic
scrolling. A regression rolls back the affected source boundary; it does not
introduce a permanent engine selector or TanStack compatibility layer.

## Reconsider criteria

Revisit the current architecture if any condition holds:

- Virt production code exceeds the normative 1,800-line total without an
  explicit responsibility split.
- The transcript controller/runtime/viewport-geometry total exceeds 1,400
  lines.
- Prefix/suffix source diffing cannot keep the 20,000-row hot-path geometry
  transaction below 1 ms p95; use a different source/update contract rather
  than hiding the cost.
- A post-commit microtask cannot be shown to observe Svelte's committed sizer
  before paint in Chromium, Firefox, and desktop WebKit.
- Physical iPhone validation still exhibits correction-induced momentum
  interruption or visible deviation redemption.
- Correctness requires importing Chat mutation or paging policy into `virt`.
- The API grows compatibility aliases for TanStack rather than domain intent.
- Upstream ships provenance-aware deferral plus painted compensation and the
  unpatched release passes Garcon's invariant and transcript suites.

## Resolved decisions

- Location: `web/src/lib/virt/`.
- Initial form: internal library with future extraction in mind.
- Geometry: keyed measurement map, incremental source diff, and
  capacity-doubling typed prefix arrays.
- Rendering: absolute rows and per-row `translateY`.
- Anchoring: consumer-selected stable key for item mutations; first visually
  intersecting geometric row for ordinary mount/resize correction; explicit
  consumer-owned end anchor while following.
- Touch correction: painted visual deviation, redeemed after native activity
  is idle, with no platform or user-agent branch.
- Provenance: `measurement | follow | navigation` plus the existing
  `dragging | coasting | idle`, never generic `isScrolling`.
- Measurement: batch uncached mount reads before paint even during scrolling.
- Browser anchoring: disabled.
- Svelte boundary: runes, immutable raw snapshot, stable attachments, and a
  post-commit microtask; no legacy stores, `flushSync`, or `tick`.
- Rollback: source revert, not a permanent runtime feature flag.
- Migration: Chat first; ordinary surfaces followed independently, and the
  fixed-height virtual window remains separate.
- Extraction: considered only after multiple internal consumers and physical
  iOS proof.

## Deferred risks

- No automated environment reproduces physical iOS momentum and rubber-band
  behavior. Physical-device validation remains mandatory.
- Positive deviation deliberately keeps prepended leading rows unreachable
  until idle redemption. Chat suppresses another earlier page and Virt redeems
  after the top bounce settles, but physical-device validation must prove this
  temporary wall is preferable to interrupting momentum.
- Row-level anchoring cannot preserve an arbitrary inner pixel when the anchor
  row itself reflows above that pixel.
- Production transcript length and resize-position distributions have not yet
  been instrumented; the initial data structure is justified by current tests
  and a preliminary benchmark, then guarded by measured thresholds.
- Firefox and desktop WebKit have not been exercised against Garcon's exact
  Virt DOM structure.
- A future standalone package needs its own packaging, semantic versioning,
  documentation, compatibility, licensing, and browser-support design.

## Acceptance criteria

Release acceptance requires:

- Pure invariants, DOM transaction tests, Chat tests, and the unmodified
  Chromium transcript suite pass.
- The Chromium coasting interleaving records zero owned physical writes for
  measurement and follow corrections.
- `bun run check` and `bun run test` pass.
- A fresh `timeout 30s bun run start --port 0` compiles and starts on a new
  port.
- Physical iPhone validation passes the documented matrix.
- No direct transcript `scrollTop` write bypasses Virt.
- No TanStack import remains in the transcript production or test boundary;
  the patch contract test has been replaced by Virt invariants.
- The Bun patch is removed or retained only for a separately proven remaining
  consumer.
- The controller/runtime/viewport-geometry total is at most 1,400 lines and
  each production file stays at or below its architecture budget.
- `ConversationScrollController` plus its extracted position helper totals at
  most 1,050 lines, and the complete Virt production core totals at most 1,800.
- Transaction instrumentation reports no unresolved deviation, multiple
  writes, stale observer acceptance, or navigation deferral.
- Rapid chat switch preserves focus, scroll position, paging isolation, and
  bounded-cache restoration.

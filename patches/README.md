# Dependency Patches

## `@tanstack/virtual-core@3.17.8`

Upstream 3.17.8 includes the out-of-range stale-measurement guard from
[`d2cf98be`](https://github.com/TanStack/virtual/commit/d2cf98beea1696c7187c06b57c9e724d1957963c),
so this patch retains only the behavior not yet released upstream.

It ignores a delayed ResizeObserver entry when its stale but still-valid index now resolves to a
key owned by another connected element. The guard stays at observer ingress: direct
`measureElement` calls must remain able to replace a connected element for the same key.

The patch also compensates an already-measured, fully above-viewport item when it shrinks during
backward scrolling. Skipping a negative delta moves later rows backward by that exact delta even
though `scrollTop` is stable. The negative adjustment follows the gesture, while positive growth
remains uncompensated so it does not fight the user's scroll direction.

It also adds `cancelScroll()`, which lets user intent supersede an owned programmatic scroll by
clearing pending reconciliation, scroll adjustments, and its animation frame without issuing
another scroll.

On iOS WebKit, above-viewport row growth during touch momentum now publishes its real geometry in
the same paint as an equal inverse margin on the virtual container. Logical offsets and ranges
include that temporary deviation, which converts to one native scroll write after momentum settles.
Touch provenance survives multi-touch handoff and cancellation, programmatic scroll commands take
over the deviation, and `cancelScroll()` preserves it for user-owned settlement. This avoids both
the uncompensated frame that moved visible rows and the mid-momentum `scrollTop` write that stops
native scrolling. Framework-neutral patch contract tests cover all four behaviors.

Remove each patch behavior once a compatible Svelte adapter resolves a core release with the same
contract and the corresponding patch tests pass unmodified against that release.

## `@tanstack/svelte-virtual@3.13.36`

The virtual-core `onChange` callback marks compensated layout notifications as synchronous so the
matching scroll or CSS correction and rendered geometry land in one paint. The Svelte adapter
previously ignored that flag, leaving its sizer and row transforms queued until Svelte's next
update. The patch wraps synchronous store publications in Svelte's `flushSync`, matching the
default contract in TanStack's React adapter. Async notifications remain unchanged.

Remove the patch once the Svelte adapter publishes synchronous notifications before `onChange`
returns and the patch regression passes unmodified against that release.

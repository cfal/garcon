# Dependency Patches

## `@tanstack/virtual-core@3.17.7`

This patch carries the production change from upstream commit
[`d2cf98be`](https://github.com/TanStack/virtual/commit/d2cf98beea1696c7187c06b57c9e724d1957963c),
which ignores connected measurement elements whose stale indexes fall outside the current item
count. The commit was merged after 3.17.7 but has not yet been published.

It also ignores a delayed ResizeObserver entry when its stale but still-valid index now resolves
to a key owned by another connected element. The guard stays at observer ingress: direct
`measureElement` calls must remain able to replace a connected element for the same key. The
in-range case is covered by a framework-neutral patch contract test and should be proposed
upstream separately from the already-merged out-of-range fix.

Remove the patch once a compatible published Svelte adapter resolves a core release containing
both guards and the connected stale-row, replacement, and count-shrink survivor regressions pass
without it.

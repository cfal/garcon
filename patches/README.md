# Dependency Patches

## `@tanstack/virtual-core@3.17.7`

This patch carries the exact production change from upstream commit
[`d2cf98be`](https://github.com/TanStack/virtual/commit/d2cf98beea1696c7187c06b57c9e724d1957963c),
which ignores connected measurement elements whose stale indexes fall outside the current item
count. The commit was merged after 3.17.7 but has not yet been published.

Remove the patch once a compatible published Svelte adapter resolves a core release containing
that commit and the connected stale-row and count-shrink survivor regressions pass without it.

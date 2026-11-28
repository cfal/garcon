import type { Preamble } from '../../../../common/preambles.ts';
import { preambleCatalogCompositionViolation } from '../../../../server/controller/preambles/catalog-budget.ts';

interface Entry {
  readonly path?: string;
  readonly executor?: string;
  readonly nested?: boolean;
  readonly disabled?: boolean;
  readonly size: number;
}

export function compositionFor(entries: readonly Entry[]) {
  return preambleCatalogCompositionViolation(entries.map((entry, index): Preamble => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    enabled: !entry.disabled,
    title: 'Synthetic',
    content: 'x'.repeat(entry.size),
    scope: entry.path === undefined ? { type: 'global' } : { type: 'project-paths', rules: [{
      projectPath: entry.path, includeNested: entry.nested ?? false, executorId: entry.executor ?? null,
    }] },
    agentIds: [],
    tagFilter: { mode: 'any', tags: [] },
    createdAt: '2026-11-28T00:00:00.000Z',
    updatedAt: '2026-11-28T00:00:00.000Z',
  })));
}

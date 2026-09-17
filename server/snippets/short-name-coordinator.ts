import type { Preamble } from '../../common/preambles.js';
import type { Snippet } from '../../common/snippets.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';

export type SnippetShortNameOwner =
  | { readonly type: 'snippet'; readonly id: string }
  | { readonly type: 'preamble'; readonly id: string };

export type AssertSnippetShortNameAvailable = (
  shortName: string,
  owner: SnippetShortNameOwner | undefined,
  conflictError: (shortName: string) => Error,
) => void;

interface SnippetShortNameSources {
  readonly snippets: () => readonly Pick<Snippet, 'id' | 'shortName'>[];
  readonly preambles: () => readonly Pick<Preamble, 'id' | 'snippetShortName'>[];
}

export class SnippetShortNameCoordinator {
  readonly #lock = new KeyedPromiseLock();

  constructor(private readonly sources: SnippetShortNameSources) {}

  assertCatalogsDoNotOverlap(): void {
    const snippetNames = new Set(this.sources.snippets().map((snippet) => snippet.shortName));
    const conflict = this.sources.preambles().find(
      (preamble) => preamble.snippetShortName !== undefined
        && snippetNames.has(preamble.snippetShortName),
    );
    if (conflict?.snippetShortName) {
      throw new Error(
        `Snippet and preamble catalogs contain the same short name: ${conflict.snippetShortName}`,
      );
    }
  }

  runMutation<T>(
    mutate: (assertAvailable: AssertSnippetShortNameAvailable) => Promise<T>,
  ): Promise<T> {
    return this.#lock.runExclusive(
      'snippet-short-names',
      () => mutate((shortName, owner, conflictError) => {
        if (this.#hasConflict(shortName, owner)) throw conflictError(shortName);
      }),
    );
  }

  #hasConflict(shortName: string, owner?: SnippetShortNameOwner): boolean {
    const snippetConflict = this.sources.snippets().some((snippet) =>
      snippet.shortName === shortName
      && (owner?.type !== 'snippet' || owner.id !== snippet.id));
    if (snippetConflict) return true;
    return this.sources.preambles().some((preamble) =>
      preamble.snippetShortName === shortName
      && (owner?.type !== 'preamble' || owner.id !== preamble.id));
  }
}

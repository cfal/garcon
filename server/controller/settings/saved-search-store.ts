import {
  SavedSearchAlreadyExistsError,
  SavedSearchNotFoundError
} from './errors.js';
import { applyWindowReorder, validateWindowReorder } from './order-helpers.js';
import type {
  ReorderResult,
  SavedChatSearch,
  SettingsStoreContext
} from './types.js';


export class SavedSearchStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getSavedSearches(): SavedChatSearch[] {
    const settings = this.#context.readSettings();
    return settings.savedChatSearches || [];
  }

  async addSavedSearch(savedSearch: SavedChatSearch): Promise<SavedChatSearch> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      if (searches.some((entry) => entry.id === savedSearch.id)) {
        throw new SavedSearchAlreadyExistsError(savedSearch.id);
      }
      s.savedChatSearches = [...searches, savedSearch];
      await this.#context.save(s);
      return savedSearch;
    });
  }

  async updateSavedSearch(searchId: string, patch: Partial<SavedChatSearch>): Promise<SavedChatSearch> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const idx = searches.findIndex((entry) => entry.id === searchId);
      if (idx < 0) {
        throw new SavedSearchNotFoundError(searchId);
      }
      searches[idx] = { ...searches[idx], ...patch };
      s.savedChatSearches = searches;
      await this.#context.save(s);
      return searches[idx];
    });
  }

  async removeSavedSearch(searchId: string): Promise<boolean> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const idx = searches.findIndex((entry) => entry.id === searchId);
      if (idx < 0) return false;
      s.savedChatSearches = searches.filter((entry) => entry.id !== searchId);
      await this.#context.save(s);
      return true;
    });
  }

  async reorderSavedSearches(oldOrder: unknown, newOrder: unknown): Promise<ReorderResult> {
    const validation = validateWindowReorder(oldOrder, newOrder);
    if (!validation.success) return validation;

    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const currentIds = searches.map((entry) => entry.id);

      const result = applyWindowReorder(currentIds, validation.oldOrder, validation.newOrder);
      if (!result) {
        return {
          success: false,
          error: 'oldOrder is not a contiguous subsequence of the current list',
          errorCode: 'ORDER_INVALID_INPUT',
          status: 400,
        };
      }

      const byId = new Map(searches.map((entry) => [entry.id, entry]));
      s.savedChatSearches = result.map((id) => byId.get(id)).filter((entry): entry is SavedChatSearch => Boolean(entry));
      await this.#context.save(s);
      return { success: true };
    });
  }
}

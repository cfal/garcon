import {
  FolderAlreadyExistsError,
  FolderNotFoundError
} from './errors.js';
import type {
  ChatFolder,
  SettingsStoreContext
} from './types.js';


export class FolderStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getFolders(): ChatFolder[] {
    const settings = this.#context.readSettings();
    return settings.chatFolders || [];
  }

  async addFolder(folder: ChatFolder): Promise<ChatFolder> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      if (folders.some((f) => f.id === folder.id)) {
        throw new FolderAlreadyExistsError(folder.id);
      }
      s.chatFolders = [...folders, folder];
      await this.#context.save(s);
      return folder;
    });
  }

  async updateFolder(folderId: string, patch: Partial<ChatFolder>): Promise<ChatFolder> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      const idx = folders.findIndex((f) => f.id === folderId);
      if (idx < 0) {
        throw new FolderNotFoundError(folderId);
      }
      folders[idx] = { ...folders[idx], ...patch };
      s.chatFolders = folders;
      await this.#context.save(s);
      return folders[idx];
    });
  }

  async removeFolder(folderId: string): Promise<boolean> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      const idx = folders.findIndex((f) => f.id === folderId);
      if (idx < 0) return false;
      s.chatFolders = folders.filter((f) => f.id !== folderId);
      await this.#context.save(s);
      return true;
    });
  }
}

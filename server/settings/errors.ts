import { DomainError } from '../lib/domain-error.js';

export class SavedSearchAlreadyExistsError extends DomainError {
  constructor(searchId: string) {
    super('SAVED_SEARCH_ALREADY_EXISTS', `Saved search with ID ${searchId} already exists`, 409);
  }
}

export class SavedSearchNotFoundError extends DomainError {
  constructor(searchId?: string) {
    super(
      'SAVED_SEARCH_NOT_FOUND',
      searchId ? `Saved search not found: ${searchId}` : 'Saved search not found',
      404,
    );
  }
}

export class FolderAlreadyExistsError extends DomainError {
  constructor(folderId: string) {
    super('FOLDER_ALREADY_EXISTS', `Folder with ID ${folderId} already exists`, 409);
  }
}

export class FolderNotFoundError extends DomainError {
  constructor(folderId?: string) {
    super(
      'FOLDER_NOT_FOUND',
      folderId ? `Folder not found: ${folderId}` : 'Folder not found',
      404,
    );
  }
}

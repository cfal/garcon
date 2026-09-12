import { createLogger } from '../lib/log.js';
import { issueStorageUnavailable } from './errors.js';
import { IssueService, type IssueServiceOptions } from './service.js';
import { IssueStore } from './store.js';

export interface IssueRuntime {
  readonly service: IssueService;
  close(): void;
}

export function initializeIssues(workspaceDir: string, options: IssueServiceOptions): IssueRuntime {
  let service: IssueService | null = null;
  try {
    service = new IssueService(new IssueStore(workspaceDir), options);
  } catch {
    createLogger('issues').warn('Issue storage could not open; Issues remain unavailable until restart.');
  }
  return {
    get service() {
      if (!service) throw issueStorageUnavailable();
      return service;
    },
    close() { service?.close(); },
  };
}

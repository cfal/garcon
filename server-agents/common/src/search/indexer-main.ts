import type { IndexerEvent } from './worker-protocol.js';
import {
  isIndexerRequest,
  workerGrantIdentity,
  workerRequestIdentity,
} from './worker-protocol.js';
import { handleIndexerRequest } from './indexer-jobs.js';

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isIndexerRequest(event.data)) {
    const identity = workerRequestIdentity(event.data);
    if (identity) self.postMessage({
      type: 'error',
      ...identity,
      grantId: workerGrantIdentity(event.data)?.grantId ?? null,
      code: 'INVALID_INDEXER_REQUEST',
      retryable: false,
    } satisfies IndexerEvent);
    return;
  }
  void handleIndexerRequest(event.data);
};

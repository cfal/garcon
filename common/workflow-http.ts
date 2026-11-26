const base = '/api/v1/workflows';

export const workflowPaths = {
  definitions: `${base}/definitions`,
  revision: `${base}/definitions/revision`,
  runs: `${base}/runs`,
  run: `${base}/runs/detail`,
  activeChats: `${base}/runs/active-chats`,
  testDraft: `${base}/runs/test`,
  decide: `${base}/runs/decision`,
  addItem: `${base}/runs/add-item`,
  addStep: `${base}/runs/add-step`,
  retry: `${base}/runs/retry`,
  stop: `${base}/runs/stop`,
  archive: `${base}/runs/archive`,
} as const;

export interface WorkflowAuthority {
  readonly key: string;
  readonly browserSession: boolean;
  assertCurrent(): void;
}

export interface WorkflowServiceOptions {
  readonly enabled: () => boolean;
  readonly now?: () => string;
  readonly onInvalidated?: (workflowId: string, revision: number) => void;
  readonly onControl?: (workflowId: string, action: 'pause' | 'stop' | 'cancel' | 'activate') => void;
}

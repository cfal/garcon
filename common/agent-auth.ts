export interface AgentDeviceAuthInfo {
  url: string;
  code?: string;
  needsCode?: boolean;
}

export interface AgentAuthLoginLaunchResult {
  launched: boolean;
  alreadyRunning: boolean;
  sessionId: string;
  deviceAuth?: AgentDeviceAuthInfo;
}

export type AgentAuthLoginStatus =
  | { state: 'idle'; running: false }
  | {
      state: 'running';
      running: true;
      sessionId: string;
      deviceAuth?: AgentDeviceAuthInfo;
    }
  | {
      state: 'succeeded';
      running: false;
      sessionId: string;
    }
  | {
      state: 'failed';
      running: false;
      sessionId: string;
      error: string;
    };

export interface AgentAuthLoginCompleteResult {
  submitted: true;
  sessionId: string;
}

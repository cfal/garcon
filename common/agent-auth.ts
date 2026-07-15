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
  | { running: false }
  | {
    running: true;
    sessionId: string;
    deviceAuth?: AgentDeviceAuthInfo;
  };

export interface AgentAuthLoginCompleteResult {
  completed: true;
  sessionId: string;
}

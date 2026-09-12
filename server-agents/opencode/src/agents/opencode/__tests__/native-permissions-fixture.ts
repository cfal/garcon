import { mock } from 'bun:test';
import type { PermissionMode } from '@garcon/common/chat-modes';
import { mapPermissionMode } from '../permissions.js';
import type { reconcileOpenCodePermissions } from '../session-configuration.js';

type PermissionMethods = Parameters<typeof reconcileOpenCodePermissions>[0]['client']['session'];

export function nativePermissionsFixture(mode: PermissionMode = 'default') {
  const rulesBySession = new Map<string, ReturnType<typeof mapPermissionMode>>();
  const rulesFor = (sessionID: string) => rulesBySession.get(sessionID) ?? mapPermissionMode(mode);
  return {
    get: mock(async ({ sessionID, directory }: Parameters<PermissionMethods['get']>[0], _options: Parameters<PermissionMethods['get']>[1]) => ({
      data: { id: sessionID, directory, permission: structuredClone(rulesFor(sessionID)) },
    })),
    update: mock(async ({ sessionID, directory, permission }: Parameters<PermissionMethods['update']>[0], _options: Parameters<PermissionMethods['update']>[1]) => {
      const rules = [...rulesFor(sessionID), ...structuredClone(permission)];
      rulesBySession.set(sessionID, rules);
      return { data: { id: sessionID, directory, permission: structuredClone(rules) } };
    }),
  } satisfies PermissionMethods;
}

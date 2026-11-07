import type { ChatAutomationPolicy } from '../../../common/automation.js';
import { DomainError } from '../../common/domain-error.js';
import { isCurrentBrowserPrincipal } from '../auth/token.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';

export function assertPermissionDecisionAuthority(
  policy: ChatAutomationPolicy | undefined,
  principal: ServerPrincipal | null | undefined,
): void {
  if (policy?.permissionDecisionAuthority !== 'browser-session') return;
  if (!principal || principal.mode !== 'authenticated' || !isCurrentBrowserPrincipal(principal)) {
    throw new DomainError('PERMISSION_DECISION_FORBIDDEN', 'This chat requires a current authenticated browser session for permission decisions.', 403);
  }
}

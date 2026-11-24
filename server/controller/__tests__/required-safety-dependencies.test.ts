import { expectTypeOf, test } from 'bun:test';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import type { CommandSupport } from '../commands/command-support.js';
import type { AgentSessionSettingsService } from '../agents/session-settings-service.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { AgentRegistry } from '../agents/registry.js';

type RequiredKey<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;

test('safety policies and shared locks cannot be omitted from constructor contracts', () => {
  type Coordinator = ConstructorParameters<typeof ChatExecutionCoordinator>[5];
  expectTypeOf<RequiredKey<Coordinator, 'canDispatch'>>().toEqualTypeOf<true>();
  expectTypeOf<RequiredKey<Coordinator, 'selectionAdmissionLock'>>().toEqualTypeOf<true>();
  expectTypeOf<RequiredKey<ConstructorParameters<typeof CommandSupport>[0], 'chatMutationLock'>>().toEqualTypeOf<true>();
  expectTypeOf<RequiredKey<ConstructorParameters<typeof AgentSessionSettingsService>[0], 'chatMutationLock'>>().toEqualTypeOf<true>();
  expectTypeOf<RequiredKey<ConstructorParameters<typeof AgentOwnershipJournal>[0], 'isExecutorConfigured'>>().toEqualTypeOf<true>();
  expectTypeOf<RequiredKey<ConstructorParameters<typeof AgentRegistry>[0], 'executors'>>().toEqualTypeOf<true>();
});

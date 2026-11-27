import { ScheduledPromptDispatcher } from './dispatcher.js';
import { ScheduledPromptRunLog } from './run-log.js';
import { ScheduledPromptScheduler } from './scheduler.js';
import { ScheduledPromptStore } from './store.js';

type ScheduledPromptDeps = Omit<ConstructorParameters<typeof ScheduledPromptScheduler>[0], 'store' | 'runLog' | 'dispatcher'>
  & ConstructorParameters<typeof ScheduledPromptDispatcher>[0];

export function initializeScheduledPrompts(workspaceDir: string, deps: ScheduledPromptDeps) {
  const { commands, chatIds, ...options } = deps;
  const scheduledPromptStore = new ScheduledPromptStore(workspaceDir, options.retainExecutorReferences, options.retainProviderReferences);
  const scheduledPrompts = new ScheduledPromptScheduler({
    ...options, store: scheduledPromptStore, runLog: new ScheduledPromptRunLog(),
    dispatcher: new ScheduledPromptDispatcher({ commands, chatIds }),
  });
  return { scheduledPromptStore, scheduledPrompts };
}

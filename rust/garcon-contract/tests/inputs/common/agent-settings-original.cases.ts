import { describe, expect, it, mock } from 'bun:test';
import * as settings from '../../../../../common/agent-settings.ts';

mock.module('vitest', () => ({ describe, expect, it }));
mock.module('$shared/agent-settings', () => settings);

await import('../../../../../web/src/lib/agents/__tests__/agent-settings.logic.test.ts');

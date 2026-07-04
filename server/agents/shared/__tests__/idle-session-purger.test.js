import { describe, expect, it, mock } from 'bun:test';
import { purgeIdleSessions } from '../idle-session-purger.ts';

describe('purgeIdleSessions', () => {
  it('purges idle sessions past the max idle age', () => {
    const sessions = new Map([
      ['running', { running: true, lastActivityAt: 0 }],
      ['fresh', { running: false, lastActivityAt: 90 }],
      ['idle', { running: false, lastActivityAt: 10 }],
    ]);
    const purge = mock((id) => {
      sessions.delete(id);
    });

    const purged = purgeIdleSessions({
      sessions: () => sessions.entries(),
      isRunning: (session) => session.running,
      lastActivityAt: (session) => session.lastActivityAt,
      purge,
    }, 100, 50);

    expect(purged).toBe(1);
    expect(purge).toHaveBeenCalledWith('idle', { running: false, lastActivityAt: 10 });
    expect([...sessions.keys()]).toEqual(['running', 'fresh']);
  });
});


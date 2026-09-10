import { mock } from 'bun:test';
import { createLocatedInstanceFixture } from './located-instance-fixture.js';

export async function createProviderAuthFixture() {
  const fixture = await createLocatedInstanceFixture();
  for (const profile of ['primary', 'secondary']) {
    /** @satisfies {import('@garcon/server-agent-interface').AgentAuth} */
    const auth = {
      status: mock(async () => ({ authenticated: profile === 'primary', canReauth: true, label: profile, source: 'cli' })),
      launchLogin: mock(async () => ({ launched: true, alreadyRunning: false, sessionId: 'colliding-session' })),
      completeLogin: mock(async function (sessionId, _code) {
        if (this !== auth) throw new Error('Auth completion lost its owning receiver');
        return { submitted: true, sessionId };
      }),
      loginStatus: mock(() => ({ state: 'running', running: true, sessionId: 'colliding-session',
        deviceAuth: { url: `https://${profile}.example.test/login` } })),
    };
    fixture[profile].integration.auth = auth;
  }
  return fixture;
}

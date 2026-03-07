import { getAmpBinary } from '../config.js';

async function getAmpAuthStatus() {
  try {
    const ampBinary = getAmpBinary();
    const proc = Bun.spawn([ampBinary, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      return { authenticated: true, email: 'Amp CLI', method: 'binary' };
    }
    return { authenticated: false, email: null, method: null };
  } catch {
    return { authenticated: false, email: null, method: null };
  }
}

async function getAmpAuthStatusRoute(request, url) {
  try {
    const result = await getAmpAuthStatus();
    if (result.authenticated) {
      return Response.json({
        authenticated: true,
        email: result.email,
        method: result.method,
      });
    }
    return Response.json({
      authenticated: false,
      email: null,
      error: 'Amp CLI not found or not authenticated.',
    });
  } catch (error) {
    return Response.json({ authenticated: false, email: null, error: error.message }, { status: 500 });
  }
}

export default {
  '/api/v1/amp/auth/status': { GET: getAmpAuthStatusRoute },
};

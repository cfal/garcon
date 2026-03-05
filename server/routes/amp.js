import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function getAmpAuthStatus() {
  // Check environment first so containerized deployments can inject keys.
  if (hasNonEmptyString(process.env.AMP_API_KEY)) {
    return { authenticated: true, email: 'API Key Auth', method: 'api_key_env' };
  }

  try {
    const secretsPath = path.join(os.homedir(), '.local', 'share', 'amp', 'secrets.json');
    const content = await fs.readFile(secretsPath, 'utf8');
    const secrets = JSON.parse(content);
    if (!secrets || typeof secrets !== 'object') {
      return { authenticated: false, email: null, error: 'Amp secrets file is malformed.' };
    }

    const entries = Object.entries(secrets);
    const hasApiKey = entries.some(([key, value]) => key.startsWith('apiKey@') && hasNonEmptyString(value));
    if (hasApiKey) {
      return { authenticated: true, email: 'Authenticated', method: 'secrets_file' };
    }

    return { authenticated: false, email: null, error: 'No usable Amp credentials were found.' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { authenticated: false, email: null, error: 'Amp authentication has not been configured.' };
    }
    return { authenticated: false, email: null, error: error.message };
  }
}

async function getAmpAuthStatusRoute() {
  try {
    const result = await getAmpAuthStatus();
    return Response.json({
      authenticated: result.authenticated,
      email: result.email,
      error: result.error || null,
    });
  } catch (error) {
    console.error('Error checking Amp auth status:', error);
    return Response.json({ authenticated: false, email: null, error: error.message }, { status: 500 });
  }
}

export default {
  '/api/v1/amp/auth/status': { GET: getAmpAuthStatusRoute },
};


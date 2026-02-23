// Classifies raw git errors into structured objects with HTTP-appropriate
// status codes and user-facing messages. Used by the route layer when
// an error is not already a GitDomainError.

export function classifyGitError(error) {
  const text = String(error?.message || '').toLowerCase();

  if (text.includes('not a git repository') || text.includes('git is not initialized')) {
    return { code: 'NOT_REPO', status: 400, message: 'Path is not a Git repository.' };
  }

  if (text.includes('does not appear to be a git repository')) {
    return {
      code: 'NO_REMOTE', status: 500,
      message: 'Remote repository is not configured.',
      details: 'Verify the remote URL and access rights.',
    };
  }

  if (text.includes('permission denied')) {
    return {
      code: 'AUTH_FAILED', status: 401,
      message: 'Git authentication failed.',
      details: 'Verify credentials or SSH key access.',
    };
  }

  if (text.includes('host key verification failed')) {
    return {
      code: 'HOST_KEY', status: 502,
      message: 'SSH host key verification failed.',
      details: 'The remote host is not in your known_hosts file. Run: ssh-keyscan <host> >> ~/.ssh/known_hosts',
    };
  }

  if (text.includes('could not resolve hostname')) {
    return {
      code: 'NETWORK', status: 502,
      message: 'Could not reach the remote host.',
      details: 'Verify network access and remote URL.',
    };
  }

  if (text.includes('please commit your changes or stash them')) {
    return {
      code: 'UNCOMMITTED_CHANGES', status: 409,
      message: 'Uncommitted local changes block this operation.',
      details: 'Commit or stash local changes before proceeding.',
    };
  }

  if (text.includes('diverged')) {
    return {
      code: 'DIVERGED', status: 409,
      message: 'Local and remote branches have diverged.',
      details: 'Fetch and review before proceeding.',
    };
  }

  if (text.includes('conflict')) {
    return {
      code: 'CONFLICT', status: 409,
      message: 'Operation produced merge conflicts.',
      details: 'Resolve conflicts, stage the fixes, then commit.',
    };
  }

  if (text.includes('nothing to commit') || text.includes('nothing added')) {
    return { code: 'NOTHING_TO_COMMIT', status: 400, message: 'No staged changes found.' };
  }

  if (text.includes('rejected') || text.includes('non-fast-forward')) {
    return {
      code: 'REJECTED', status: 409,
      message: 'Push was rejected by the remote.',
      details: 'The remote has newer commits. Pull and reconcile first.',
    };
  }

  if (text.includes('no upstream branch')) {
    return {
      code: 'NO_UPSTREAM', status: 400,
      message: 'No upstream branch is configured.',
      details: 'Run: git push --set-upstream origin <branch>.',
    };
  }

  if (text.includes('index.lock') || (text.includes('unable to create') && text.includes('.lock'))) {
    return {
      code: 'GIT_LOCKED', status: 409,
      message: 'Git index is locked by another process.',
      details: 'Another git operation may be running. Wait and retry, or remove the stale lock file.',
    };
  }

  if (text.includes('no such file or directory') && text.includes('ssh')) {
    return {
      code: 'SSH_MISSING', status: 502,
      message: 'SSH client is not available.',
      details: 'Ensure an SSH client is installed and accessible in PATH.',
    };
  }

  return { code: 'UNKNOWN', status: 500, message: String(error?.message || 'Git operation failed.') };
}

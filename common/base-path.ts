export function parseBasePath(value: string): string {
  if (value === '' || value === '/') return '';
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  if (
    normalized.length > 1024
    || !normalized.startsWith('/')
    || /[^A-Za-z0-9._~/-]/.test(normalized)
    || normalized.slice(1).split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid base path: use an absolute path of unescaped letters, digits, dots, hyphens, underscores, or tildes, without empty or dot segments');
  }
  return normalized;
}

export function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === '') return pathname.startsWith('/') ? pathname : null;
  if (pathname === basePath) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

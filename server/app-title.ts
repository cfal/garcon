import type { UiSettings } from './settings/types.js';
import { normalizeUiSettings } from './settings/settings-shared.js';
import { DEFAULT_APP_TITLE } from '../common/settings.js';

export interface PublicAppTitle {
  title: string;
  version: number;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function appTitleBootstrapScript(appTitle: PublicAppTitle): string {
  return `<script>globalThis.__GARCON_APP_TITLE__=${safeInlineJson(appTitle)}</script>`;
}

export function resolvePublicAppTitle(ui: UiSettings, version: number): PublicAppTitle {
  const normalizedUi = normalizeUiSettings(ui);
  const appIdentity = asRecord(normalizedUi.appIdentity);
  const title = typeof appIdentity?.title === 'string' && appIdentity.title.trim()
    ? appIdentity.title.trim()
    : DEFAULT_APP_TITLE;

  return { title, version };
}

export function injectAppTitleIntoShell(shell: string, appTitle: PublicAppTitle): string {
  const title = escapeHtml(appTitle.title);
  const bootstrap = appTitleBootstrapScript(appTitle);
  let html = /<title>[^<]*<\/title>/.test(shell)
    ? shell.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    : shell.replace('</head>', `\t\t<title>${title}</title>\n\t</head>`);

  html = html.replace(
    /<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"\s*\/?>/,
    `<meta name="apple-mobile-web-app-title" content="${title}" />`,
  );

  return html.replace('</head>', `\t\t${bootstrap}\n\t</head>`);
}

export function applyManifestTitle(rawManifest: string, appTitle: PublicAppTitle): string {
  const parsed = JSON.parse(rawManifest) as Record<string, unknown>;
  return JSON.stringify({
    ...parsed,
    name: appTitle.title,
    short_name: appTitle.title,
  }, null, '\t');
}

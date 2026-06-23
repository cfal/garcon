// Renders the shared-chat HTML page. Enriches the SPA shell so a shared link is
// both human-friendly (the Svelte app hydrates as usual) and agent-friendly: the
// served HTML carries Open Graph/Twitter metadata, a machine-discoverable link to
// the plain-text transcript, and a no-JavaScript transcript fallback that agents
// and crawlers can read directly. The fallback is removed the instant JS runs, so
// browser users never see it.

import type { SharedChatSnapshot } from '../../common/share-types.ts';
import { renderSharedChatText } from './share-transcript.ts';

const FALLBACK_ELEMENT_ID = 'garcon-shared-fallback';
const DESCRIPTION_MAX_LENGTH = 200;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function shareTitle(snapshot: SharedChatSnapshot): string {
  const title = snapshot.title?.trim();
  return title && title.length > 0 ? title : 'Shared chat';
}

// Prefers the chat title (already the first user line at share time); falls back
// to a generic agent description when the title is absent or a placeholder.
function shareDescription(snapshot: SharedChatSnapshot): string {
  const title = snapshot.title?.trim();
  if (title && title !== 'Untitled Chat') {
    return title.length > DESCRIPTION_MAX_LENGTH
      ? `${title.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
      : title;
  }
  return `Shared ${snapshot.agentId || 'agent'} conversation`;
}

function buildHeadTags(snapshot: SharedChatSnapshot, token: string, canonicalUrl: string): string {
  const title = escapeHtml(shareTitle(snapshot));
  const description = escapeHtml(shareDescription(snapshot));
  const llmHref = escapeHtml(`/shared/llm/${encodeURIComponent(token)}`);

  return [
    `<title>${title} · Garcon</title>`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Garcon" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    canonicalUrl ? `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />` : '',
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<link rel="alternate" type="text/plain" title="Plain-text transcript for LLMs" href="${llmHref}" />`,
  ]
    .filter(Boolean)
    .join('\n\t\t');
}

// Builds the no-JS transcript block. When removable, an inline script strips it
// before the SPA mounts so browser users never see raw text; agents and crawlers
// that do not execute JavaScript read the transcript straight from the markup.
function buildBodyFallback(snapshot: SharedChatSnapshot, removable: boolean): string {
  const transcript = escapeHtml(renderSharedChatText(snapshot));
  const block = `<div id="${FALLBACK_ELEMENT_ID}"><pre>${transcript}</pre></div>`;
  if (!removable) return block;
  return `${block}<script>document.getElementById(${JSON.stringify(FALLBACK_ELEMENT_ID)})?.remove()</script>`;
}

// Injects share context into the SPA shell, replacing its static <title> with the
// share-specific head tags and inserting the removable transcript fallback as the
// first body child.
export function injectSharedChatContext(
  shell: string,
  snapshot: SharedChatSnapshot,
  token: string,
  canonicalUrl: string,
): string {
  const head = buildHeadTags(snapshot, token, canonicalUrl);
  const body = buildBodyFallback(snapshot, true);

  let html = /<title>[^<]*<\/title>/.test(shell)
    ? shell.replace(/<title>[^<]*<\/title>/, head)
    : shell.replace('</head>', `\t\t${head}\n\t</head>`);
  html = html.replace(/<body[^>]*>/, (match) => `${match}${body}`);
  return html;
}

// Self-contained shared page used when the SPA shell is unavailable (e.g. the
// build output is missing). Keeps the transcript visible since no SPA will mount.
export function renderStandaloneSharedHtml(
  snapshot: SharedChatSnapshot,
  token: string,
  canonicalUrl: string,
): string {
  const head = buildHeadTags(snapshot, token, canonicalUrl);
  const body = buildBodyFallback(snapshot, false);
  return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${head}
	</head>
	<body>
		${body}
	</body>
</html>
`;
}

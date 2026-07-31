# BROWSER_SURFACE_DESIGN

Status: proposed. Author research date: 2026-07-29. Branch: `iframe-browser`.

An in-app Browser surface for Garcon: a workspace tab that embeds arbitrary `http(s)` pages in a sandboxed iframe behind an address bar, an "Open Browser" entry in the workspace taskbar popup (below "New Terminal"), and a Local Settings toggle that routes external links from chat/markdown into that surface instead of a new browser tab.

---

## 1. Problem statement and goals

Garcon users preview the apps their agents are building (usually `localhost` dev servers) and read web docs while chatting. Today every link leaves the app via `target="_blank"`, and there is no way to keep a page docked next to a chat, terminal, or diff.

Goals:

- A `Browser` workspace surface with an address bar at the top so users can navigate to arbitrary URLs, docked in `main` or `sidebar` like every other portable surface.
- An "Open Browser" action in the workspace taskbar dropdown, below "New Terminal", and a Command Menu entry (which also covers mobile).
- A Local Settings toggle, "Open web links in Browser tab", that captures plain clicks on external markdown links into the surface. Modifier-clicks and middle-clicks keep opening a real browser tab.
- URL and open/closed state survive reload.
- Do all of the above without weakening Garcon's security posture; harden the few places embedding interacts with (Section 6).

Non-goals (explicit scope boundaries):

- No multiple simultaneous browser tabs (multi-instance). Section 13 documents the upgrade path.
- No server-side proxying, header stripping, or rendering of workspace HTML files. Rejected on security grounds (Section 8).
- No attempt to mirror the framed page's real location, intercept its link clicks, or inject scripts into it. Impossible cross-origin; the limitations are documented UX (Section 9).
- No per-chat or per-project browser state.
- No CSP rollout for the whole app; only the targeted headers in Section 6.4.

## 2. Verdict on "can it even be done safely?"

Yes, with three rules that this design enforces:

1. **No app-origin document can ever render in the frame.** The client refuses to *commit* same-origin URLs, but that alone is not the invariant: a framed page can navigate itself to an app URL, or the target can redirect there, and neither is blocked by the sandbox. So the durable guarantee is server-side — every app-origin HTML document sends `X-Frame-Options: DENY` + `frame-ancestors 'none'` (Section 6.4), and the raw-bytes endpoint sends `CSP: sandbox`. Both layers are required; the client check alone would leave `allow-same-origin` unsafe.
2. **Embed only cross-origin content, never Garcon's own origin.** Garcon's auth token lives in `localStorage` (`web/src/lib/api/client.ts`, key `bearer-token`). A cross-origin iframe cannot touch the parent DOM, storage, or token — that is the browser's core guarantee. A *same-origin* iframe could. The only way attacker-influenced content could ever be same-origin is Garcon's raw file endpoint (`/api/v1/files/content`, `server/routes/files.ts:585-617`, registered at `files.ts:704`), which serves workspace bytes with their true MIME type (`text/html` included). It is protected by header-only Bearer auth (`server/lib/http-request.ts:30-36` — no query token, no cookies), which an iframe navigation cannot supply — except in `authDisabled` mode (`server/config.ts:121`), where every route is open. So the client refuses same-origin URLs in the surface (Section 5.3) and the server adds `Content-Security-Policy: sandbox` to that endpoint (Section 6.4), closing the hole in all modes. This is precisely the bug class behind Theia's mini-browser RCE (Section 4.2).
3. **Never proxy.** Stripping `X-Frame-Options` server-side means serving arbitrary hostile content from the app origin — the Theia CVE and Coder's own "disable path-based apps" guidance both exist because of this. Sites that refuse framing get an explicit "open externally" fallback instead.
4. **The frame gets no capability a normal tab wouldn't have.** Sandbox flags block top-navigation; permissions policy grants nothing but fullscreen; the app carries no ambient credentials (no cookies) a framed page could ride on (no CSRF vector); Garcon has zero `window.addEventListener('message')` handlers today (verified — only WebSocket `onmessage` in `web/src/lib/ws/connection.svelte.ts` and a `BroadcastChannel` in `workspace/terminal-client-identity.svelte.ts`, neither reachable from a frame), and this doc adds a standing rule for future ones (Section 6.5).

Residual, accepted risks are listed in Section 12.

## 3. Current system behavior (source map)

All paths relative to repo root.

| Concern | Where | Behavior relevant here |
| --- | --- | --- |
| Surface kinds | `web/src/lib/workspace/surface-types.ts:6-13` | `PORTABLE_SINGLETON_KINDS = ['git','git-history','git-compare','pull-requests','files','commit']`; `portableSingletonDescriptor()` switch at `:112`. |
| Singleton controllers | `web/src/lib/workspace/singleton-surfaces.svelte.ts` | `SingletonSurfaceRegistry` with per-kind factories; controllers implement `PortableSingletonController` (`portable-singleton-controller.ts`: `setProjectState`, `setPresentationVisible`, `dispose`). `FilesSurfaceController` is the no-server-deps template. |
| Surface rendering | `web/src/lib/components/workspace/PortableSurfaceContent.svelte` | Lazy renderer per kind; project-dependent kinds wrap in `ProjectSurfaceGate`; all inside `<svelte:boundary>`. |
| Taskbar popup | `web/src/lib/components/workspace/WorkspaceTaskBar.svelte:411-445` | "New Terminal" item, then git views, then `otherClosedSingletonKinds` loop renders `m.workspace_open_surface({surface})` for every closed portable kind in `PORTABLE_SINGLETON_KINDS` order. A new kind appended to the array automatically appears below "New Terminal". |
| Open/focus | `web/src/lib/workspace/workspace-coordinator.svelte.ts:249-288` | `openSingleton(kind, preferredHostIfAbsent)` is fully kind-generic. `focusMobileSingleton(kind)` (`:552`) covers mobile. |
| Layout persistence | `common/workspace-layout.ts` (kind union), `web/src/lib/workspace/layout-schema.ts:27-44` (`parseRef`) | Singleton + terminal refs persist to `localStorage` key `workspace_layout_v1`. |
| Command palette | `web/src/lib/components/shared/CommandMenu.svelte:140-190` | One entry per surface, `isMobile ? focusMobileSingleton : openSingleton`. |
| Labels | `WorkspaceTaskBar.svelte:90-97` (`singletonLabels`), `WorkspaceRoot.svelte:254-261` (short labels), icon snippet `WorkspaceTaskBar.svelte:257-268` | Exhaustive `Record<PortableSingletonKind, ...>` maps — `bun run check` will flag every site to update. |
| Local settings | `web/src/lib/stores/local-settings.svelte.ts`, UI `web/src/lib/components/settings/LocalSettingsSection.svelte` | Snapshot + parse + `$state` fields + `settingRow` snippet. Persisted at `pref_local_settings`. |
| Chat/markdown links | `web/src/lib/components/chat/Markdown.svelte:131-153` | `link` snippet: file links → `onLinkNavigate` callback; external links → `target="_blank" rel="noopener noreferrer"`. Consumers passing `onLinkNavigate`: `ConversationMessage`, `PermissionRequestRow`, `CompactionRow`, `ChatToolRichTextView`, `files/MarkdownViewer`. |
| Typed context | `web/src/lib/context/index.ts` | `export const [getX, setX] = createContext<T>()`; optional-getter precedent `getOptionalTransientLayers()` (`:74-80`). Root contexts set in `web/src/routes/+layout.svelte`. |
| HTTP auth | `server/lib/http-route.ts` (wrap + `markRouteNoAuth`), `server/lib/http-request.ts:30-36` | Bearer header only. Client stores token in `localStorage` and injects it (`web/src/lib/api/client.ts:42-49`). WS auth via `Sec-WebSocket-Protocol` (`docs/security.md`). |
| Raw file bytes | `server/routes/files.ts:585-617` `handleContent` | Serves any workspace file with real MIME type; auth-wrapped; no framing/CSP headers. |
| Static serving | `server/routes/static.ts:28-54` (`cacheHeaders`/`staticHeaders`), index fallback `:145` | **No** `X-Frame-Options`, CSP, `Referrer-Policy`, or `X-Content-Type-Options` anywhere in the server today (verified by grep). |
| Existing iframes | none in `web/src` (verified) | This is the first embedded browsing context. |
| i18n | `web/messages/en.json` (only locale) | Regenerate Paraglide after key changes (repo rule). |
| Tests | `web/src/lib/workspace/__tests__/` (`layout-schema.test.ts`, `singleton-surfaces.test.ts`, `workspace-coordinator.test.ts`), `web/src/lib/components/workspace/__tests__/` (`WorkspaceTaskBar.test.ts`, `WorkspaceRoot.test.ts`), `server/routes/__tests__/` (`static.test.js`, `files.test.js`), e2e in `integration-tests/tests/e2e/` | Patterns to extend. |

## 4. Research: how other IDEs embed browsers

### 4.1 VS Code Simple Browser (iframe, accepts refusal)

Source inspected 2026-07-29 on `microsoft/vscode` `main`:

- `extensions/simple-browser/src/simpleBrowserView.ts:169`:
  `<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"></iframe>` — no `allow-top-navigation*`, no `allow-popups`, no `allow-modals`. The iframe is additionally nested inside a VS Code webview, which runs on a separate origin from the workbench, so `allow-same-origin` can never reach workbench state.
- `extensions/simple-browser/preview-src/index.ts`: back/forward buttons call bare `history.back()`/`history.forward()` (safe only because the webview's session history is isolated from the workbench). The reload handler carries this comment: *"This incorrectly adds entries to the history but does reload. It also always incorrectly always loads the value in the input bar, which may not match the current page if the user has navigated"* — first-party confirmation that an embedding host cannot read the frame's real location and that naive `src` reassignment pollutes history. They cache-bust with a `vscodeBrowserReqId` query param.
- Sites sending `X-Frame-Options`/`frame-ancestors` simply render blank; VS Code offers "open externally". This is the accepted industry baseline for iframe browsers.

### 4.2 Eclipse Theia mini-browser (the cautionary tale)

CVE-2021-34435 / [Eclipse bug 568018](https://bugs.eclipse.org/bugs/show_bug.cgi?id=568018): the mini-browser served workspace files from the *same origin* as the IDE, so opening a malicious workspace HTML file executed script with IDE-origin authority → RCE. Fix ([PR #8759](https://github.com/eclipse-theia/theia/pull/8759), [discussion #10699](https://github.com/eclipse-theia/theia/discussions/10699)): serve that content from `{{uuid}}.mini-browser.{{hostname}}` — a dedicated origin. Direct lesson for Garcon: `/api/v1/files/content` must never be renderable as a document on the app origin; see Sections 5.3 and 6.4.

### 4.3 code-server / Coder (separate-origin proxying)

code-server proxies workspace ports either path-based (`/proxy/<port>`, same origin) or subdomain-based (`<port>.domain`). Coder's [security best practices](https://coder.com/docs/tutorials/best-practices/security-best-practices) recommend disabling path-based apps because they share the IDE origin: a malicious workspace app can XSS the IDE and reuse its cookies. Gitpod/Replit likewise put previews on per-workspace subdomains. Garcon does not proxy at all (users browse `localhost` ports directly, which is cross-origin to Garcon), so we inherit none of this; the finding forbids ever adding a same-origin proxy "to make blocked sites work".

### 4.4 Platform behavior facts the design depends on

- **Framing refusal**: `X-Frame-Options: DENY|SAMEORIGIN` and CSP `frame-ancestors` (which [takes precedence](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options) when both present) block embedding at the browser level. Not detectable reliably from JS: the `load` event fires even for blocked frames in Chromium, and cross-origin `contentDocument` access throws regardless. Deterministic detection requires reading response headers → the Phase-2 advisory endpoint (Section 7).
- **Joint session history**: subframe navigations append entries to the tab's back/forward list ([WHATWG #6501](https://github.com/whatwg/html/issues/6501) documents this as the "iframes pollute the back button" problem). Per the [Chromium session history doc](https://chromium.googlesource.com/chromium/src/+/master/docs/session_history.md), the *first* load of a newly inserted iframe is an "auto subframe navigation" that does **not** create a new entry; later navigations (including `src` reassignment) do. Design consequence: every host-initiated navigation (address bar, reload, back/forward) **remounts the iframe element** instead of reassigning `src` (Section 5.4). Traversing a subframe entry does not fire `popstate` on the top window, so SvelteKit routing is unaffected by in-frame history the user creates by clicking inside the frame.
- **Sandbox semantics**: `allow-scripts allow-same-origin` together are only an escape risk when the framed document is same-origin with the embedder ([MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)); for cross-origin content the combination is standard (VS Code ships it). Omitting `allow-top-navigation*` blocks frame-busting (`top.location = ...` throws in the frame). Chrome ≥92 already ignores `alert/confirm/prompt` from cross-origin iframes, so `allow-modals` buys nothing.
- **Cookies/storage in frames**: Safari and Firefox partition third-party storage; Chrome retains third-party cookies (opt-out) after abandoning full deprecation. Practical effect: users may appear logged-out inside the frame on sites where they are logged in top-level. [`<iframe credentialless>`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/IFrame_credentialless) (Chrome ≥110, not Firefox/Safari) would make that ephemerality explicit; not needed since Garcon sets no COEP — recorded as future option only.
- **Mixed content**: an `https`-served Garcon can frame `http://localhost` / `http://127.0.0.1` (loopback is "potentially trustworthy"), but `http://` on any other host is blockable mixed content and will not load. Deterministically detectable client-side → inline warning (Section 5.5). Chrome's rolling Local Network Access changes may additionally prompt/block public→private embeds; advisory copy only, no design dependency.

Sources: [VS Code simple-browser source](https://github.com/microsoft/vscode/tree/main/extensions/simple-browser), [Trail of Bits on webview isolation](https://blog.trailofbits.com/2023/02/21/vscode-extension-escape-vulnerability/), [Theia mini-browser package](https://github.com/eclipse-theia/theia/tree/master/packages/mini-browser), [Theia PR #8759](https://github.com/eclipse-theia/theia/pull/8759), [CVE list](https://www.cvedetails.com/vulnerability-list/vendor_id-10410/product_id-76702/Eclipse-Theia.html), [code-server guide](https://github.com/coder/code-server/blob/main/docs/guide.md), [Coder security best practices](https://coder.com/docs/tutorials/best-practices/security-best-practices), [WHATWG #6501](https://github.com/whatwg/html/issues/6501), [Chromium session history](https://chromium.googlesource.com/chromium/src/+/master/docs/session_history.md), [MDN credentialless](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/IFrame_credentialless), [Chrome credentialless blog](https://developer.chrome.com/blog/iframe-credentialless).

## 5. Proposed design

### 5.1 Shape: a new portable singleton kind `browser`

`browser` joins `PORTABLE_SINGLETON_KINDS`. Rationale: the portable-singleton machinery supplies taskbar tab, popup menu entry ("Open Browser", rendered below "New Terminal" by the existing `otherClosedSingletonKinds` loop), host moves, dialog/mobile presentation, layout persistence, and close/dispose — all for a ~6-line type change plus one controller and one component. Terminal-style multi-instance would require a new descriptor type, an id registry, a placement service (`terminal-placement-service.ts` is 16.6K), and a persistence schema change; deferred (Section 13). The exhaustive `Record<PortableSingletonKind, ...>` maps make `bun run check` enumerate every remaining touchpoint.

New domain `web/src/lib/browser/` (repo rule: new domains use `lib/<domain>`):

```
web/src/lib/browser/
  browser-url.ts                  pure URL normalization/validation
  browser-surface.svelte.ts       BrowserSurfaceController (rune state)
  external-link-policy.ts         ExternalLinkPolicy interface
  browser-link-opener.ts          BrowserLinkOpener (policy implementation)
  __tests__/
web/src/lib/components/browser/
  BrowserSurface.svelte           toolbar + iframe renderer
  __tests__/
```

Layering: `lib/browser` imports `lib/workspace` and `lib/stores` (domain→domain, allowed), never `lib/components`; `components/browser` imports `lib/browser`. `bun run lint` enforces this.

### 5.2 The iframe contract (security core)

```svelte
<iframe
  title={m.browser_frame_title()}
  src={controller.committedUrl}
  sandbox={BROWSER_IFRAME_SANDBOX}
  referrerpolicy="no-referrer"
  allow="fullscreen"
  class="h-full w-full border-0 bg-white"
></iframe>
```

`BROWSER_IFRAME_SANDBOX` (exported const in `browser-surface.svelte.ts`):

```
allow-scripts allow-forms allow-same-origin allow-downloads allow-popups
```

Per-token rationale:

| Token | Why |
| --- | --- |
| `allow-scripts`, `allow-forms` | Pages are useless without them. |
| `allow-same-origin` | Framed sites need their own cookies/storage to function. The flag lets the frame be *its own* origin, not ours. Safe only because of the two-layer invariant in Section 2: the client refuses to commit same-origin URLs (Section 5.3) **and** every app-origin document refuses framing server-side (Section 6.4). The client check alone is insufficient — a framed page can navigate itself or be redirected to an app URL. |
| `allow-downloads` | Dev-server artifacts, docs downloads. VS Code parity. |
| `allow-popups` | `target="_blank"` and OAuth popups inside framed pages otherwise fail silently (a known VS Code annoyance). Popup blockers still apply. |
| omitted: `allow-popups-to-escape-sandbox` | Rejected during review. An escaped popup is an *unsandboxed* top-level context that keeps an `opener` reference, so script in it can assign `opener.top.location` and navigate the Garcon tab away — defeating the no-top-navigation rule the sandbox otherwise enforces. Popups still open; they inherit the sandbox instead. |
| omitted: `allow-top-navigation`, `allow-top-navigation-by-user-activation` | The frame must never navigate Garcon away (frame-busting becomes a no-op error inside the frame). |
| omitted: `allow-modals` | Chrome ≥92 suppresses cross-origin subframe dialogs anyway; keeps hostile pages from blocking our UI elsewhere. |
| omitted: `allow-pointer-lock`, `allow-storage-access-by-user-activation` | Not needed for v1; the latter is the future hook for SSO-in-frame on partitioned browsers (Section 13). |

`allow="fullscreen"` only — camera, mic, geolocation, clipboard-write etc. stay default-denied for cross-origin frames because they are not delegated. `referrerpolicy="no-referrer"` keeps the Garcon host URL out of framed sites' logs. `bg-white` is deliberate and exempt from the semantic-token rule: it reproduces the browser's default white canvas behind pages that assume it; it is web-content ground, not app UI (comment in component).

### 5.3 URL policy (`browser-url.ts`)

Accept only `http:`/`https:`. Refuse: empty/unparseable input, any other scheme (`javascript:`, `data:`, `blob:`, `file:`, `about:` — never assign these to `src`), URLs with userinfo (`user:pass@host` phishing shape), and **any URL whose origin equals `window.location.origin`** (the Theia rule; also prevents Garcon-in-Garcon recursion). Scheme defaulting for bare input: loopback hosts (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) default to `http://`, everything else to `https://`. Full code in Section 10, step 3.

The same-origin comparison is exact-origin, which is correct: reaching the same server via a different host/port is cross-origin in the browser and cannot touch `localStorage`.

### 5.4 Navigation model (address bar truth, history hygiene)

- `committedUrl` = last URL the host committed to the frame. The address bar shows it (editable). In-frame navigation by the user is invisible to us (cross-origin), so the bar can drift from the real page — same as VS Code; the bar gets `title={m.browser_address_shows_committed()}` explaining it shows the last address opened. Accepted limitation, revisit never (unfixable client-side).
- Every host navigation — Go, reload, back, forward, link capture — bumps `frameGeneration`, and the template wraps the iframe in `{#key controller.frameGeneration}`. Remounting means each host navigation is a fresh frame's initial "auto subframe" load: **zero joint-session-history entries**, so the SPA's back button and SvelteKit routing never absorb our navigations (the VS Code reload bug from Section 4.1 designed out). Cost: remount loses frame scroll/form state — identical to a real reload, acceptable.
- Back/forward operate on a host-side stack of committed URLs (capped 50). They cannot see in-frame clicks (nothing can, cross-origin); they step through addresses the user entered/captured. `history.back()` on the joint history (VS Code's approach) is rejected: outside webview isolation it can pop Garcon's own SPA route.
- Reload = remount with the same `committedUrl` (normal HTTP-cache semantics, URL unpolluted — improves on VS Code's cache-buster param).
- "Open externally" button = `<a href={committedUrl} target="_blank" rel="noopener noreferrer">` — always visible; it is the escape hatch for sites that refuse framing.
- Moving the surface between hosts reparents the DOM node, which reloads the framed document (platform behavior). Accepted; the same URL recommits.

### 5.5 Load-state UX honesty

Framing refusal is not client-detectable (Section 4.4), so v1 does not pretend: the empty state and the address-bar hint say some sites refuse embedding and offer "Open externally". One case *is* deterministic and gets an inline banner immediately: `https`-served Garcon + `http://` non-loopback target = mixed content, will never load. Phase 2 (Section 7) adds the advisory server probe that turns refusal into an explicit banner.

### 5.6 Settings and link capture

- New local setting `openLinksInBrowserSurface` (default `false`), rendered in `LocalSettingsSection` with a description; snapshot/parse/toggle exactly like existing booleans.
- New typed context `ExternalLinkPolicy` with an optional getter (`getOptionalExternalLinkPolicy()`, mirroring `getOptionalTransientLayers`). `Markdown.svelte` consults it for external links on plain left-click only (no meta/ctrl/shift/alt); modifier and middle clicks fall through to the existing `target="_blank"`. Consumers of `Markdown.svelte` need **zero changes**; contexts absent (e.g. the `/shared` route) mean unchanged behavior. This covers chat transcripts, permission rows, compaction rows, rich tool views, and the files Markdown viewer in one place.
- `BrowserLinkOpener` (the policy implementation, constructed in `+layout.svelte` beside the other root contexts) checks the setting, normalizes the URL, and on success commits it to the controller and opens the surface — `sidebar` host preferred so the chat stays visible; `focusMobileSingleton` on mobile. Any rejection (setting off, non-http(s), same-origin) returns `false` → the link opens in a real tab as today. Capture never becomes a link-breaking failure mode.

### 5.7 Persistence

- Layout ref: `{ type: 'singleton', kind: 'browser' }` added to `common/workspace-layout.ts` + `layout-schema.ts` `parseRef`. Old persisted layouts lack it (additive, no migration); new layouts opened in old builds fall back canonically (existing `parseRef` drop behavior) — acceptable, and the repo explicitly does not do backwards compatibility.
- URL state: new `LOCAL_STORAGE_KEYS.browserSurface = 'browser_surface_v1'` storing `{ url }` (length-clamped 8 KiB). Restored on controller construction, so close/reopen and full reload land on the last page. Back/forward stacks are session-only (deliberate simplification: persisting them buys little; ceiling noted in code comment).
- Ephemerality rules untouched: no server state anywhere in this feature (Phase 2's endpoint is stateless).

### 5.8 Accessibility and mobile

- Toolbar buttons: real `<button>`s with `aria-label` + `title`, `focus-visible` rings; address input labeled; iframe `title` (Svelte a11y requires it). Tab order: back, forward, reload, address, go, open-external.
- Repo rule: touch form controls ≥16px computed font-size — the address input uses the same touch-size utility as existing dialog inputs (`text-base sm:text-sm` pattern; match `SidebarProjectPathDialog`'s input classes at implementation time).
- Mobile: reachable via Command Menu (`focusMobileSingleton('browser')`); not added to `MOBILE_WORKSPACE_TABS` (bottom bar stays five items; `commit` sets precedent for menu-only surfaces).
- Keyboard focus inside the iframe swallows global shortcuts (platform behavior; VS Code shows a "Focus Lock" chip for this). v1 accepts it; the taskbar remains mouse/touch reachable. Future: focus indicator on the surface frame.

## 6. Threat model and hardening

Assets: bearer token in `localStorage`; chat/workspace data behind the API; the user's trust in Garcon chrome.

| Threat | Vector | Disposition |
| --- | --- | --- |
| Token/DOM theft by framed page | Same-origin framing of attacker-influenced content | **Blocked twice**: client same-origin URL refusal (5.3); `CSP: sandbox` on `/api/v1/files/content` (6.4) so even a direct/authDisabled navigation renders workspace HTML with an opaque origin and no script. |
| Frame escapes into app UI | `top.location`, layout overlay | Sandbox omits `allow-top-navigation*`; the frame is clipped to its pane; it cannot read or move app DOM. |
| postMessage abuse | Framed page posts to `window.parent` with `'*'` | No window message listeners exist (verified). **Standing rule added by this doc**: any future `window` `message` listener must check `event.origin` allowlist first; add lint-grep to review checklist. |
| CSRF against Garcon API | Frame issues requests to app origin | No cookie auth — requests lack the Bearer header; JSON routes reject form/no-cors bodies. In `authDisabled` mode this equals the pre-existing exposure from any site in any tab (embedding adds nothing); recommend a separate hardening issue for an `Origin` allowlist on mutating routes in `authDisabled` mode (out of scope here). |
| Phishing inside the frame | Hostile page renders fake Garcon login | Address bar always shows the committed URL; frame region visually distinct (border + toolbar). Residual risk accepted (identical to VS Code/Theia). Garcon never asks for credentials outside `/login`, which the same-origin block keeps out of the frame. |
| Referer/URL leakage to framed sites | Default referrer policy | `referrerpolicy="no-referrer"` on the frame; `Referrer-Policy: same-origin` on app documents (6.4). |
| Clickjacking of Garcon by other sites | Garcon framed elsewhere | `X-Frame-Options: DENY` + `frame-ancestors 'none'` on **every** app HTML document, including `/shared/:token` (6.4). |
| Framed page navigates *itself* to an app-origin document | `location.href = <app>/…` inside the frame, or the target answering with a redirect to the app origin | The client URL policy only governs host-committed URLs, so it cannot prevent this; the sandbox does not block a frame navigating itself (only `allow-top-navigation*` is withheld). The defense is server-side: every app-origin document refuses framing, so the navigation cannot render. This is why `/shared/:token` must carry the headers — it boots the full SPA. |
| Resource abuse (miners, audio) | Any framed page | Visible, closable tab; iframe stays mounted when its tab is hidden (surfaces are kept alive by design — same as a background browser tab). Accepted. |
| Drive-by downloads / popup spam | `allow-downloads`, `allow-popups` | Browser download/popup UI mediates; identical exposure to normal browsing. Accepted. |
| DNS rebinding via framed page | Frame fetches `http://localhost:<garcon-port>` | API needs the Bearer header; static assets are public by design. No new exposure vs. a normal tab. |

### 6.4 Server hardening headers (Phase 0, ships first)

1. `server/routes/static.ts`: add `X-Content-Type-Options: nosniff` to all static responses, and apply the app-document header set (`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: same-origin`) to `.html` responses. The header set lives in one exported helper, `applyAppDocumentSecurityHeaders()`, because `/shared/:token` builds its own `Response` and would otherwise silently miss it — every HTML-serving route must call it.
2. `server/routes/files.ts` `handleContent()`: add `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` to the raw-bytes response. The app's own consumption is unaffected — it fetches via `authenticatedFetch` into blobs, where response CSP does not apply.

### 6.5 Rules this design adds to the codebase

- Never render remote or workspace-derived documents from the app origin; anything document-renderable on our origin must carry `CSP: sandbox` or live on a dedicated origin.
- Any `window.addEventListener('message', …)` must validate `event.origin` before touching the payload.
- Never add a proxy that rewrites anti-framing headers.

(Record these three in `docs/security.md` as part of Phase 0.)

## 7. Phase 2: advisory embed-check endpoint

`GET /api/v1/browser/embed-check?url=<encoded>` (auth-wrapped like every route; stateless).

Server fetches the URL cookieless with `redirect: 'manual'` (≤5 hops, each hop re-validated `http(s)`, 5 s `AbortSignal.timeout`, body cancelled unread) and reports only a framing verdict derived from `X-Frame-Options` and CSP `frame-ancestors`:

```jsonc
{ "verdict": "embeddable" | "blocked" | "restricted" | "unreachable" }
```

- `blocked`: `XFO: DENY`, or `SAMEORIGIN` (we are never the target's origin), or `frame-ancestors 'none'`.
- `restricted`: `frame-ancestors` present with a non-`*` list (we cannot know our public origin behind proxies; treat as likely-blocked).
- Client behavior: fire-and-forget in parallel with committing the iframe (never gates or delays navigation); a `blocked`/`restricted` verdict shows the "site refuses embedding — open externally" banner. Verdicts are advisory because a cookieless server fetch can differ from the user's credentialed view.
- SSRF analysis: single-user tool; caller is the same authenticated user who already has shell via terminals, so server-side fetch grants no new reach; scheme-restricted, response body never returned, and nothing echoed back beyond the verdict itself. The route additionally requires an `X-Garcon-Embed-Check` header that only same-origin script can set, so framed content cannot drive it when auth is disabled. Contract discipline: typed request/response in `common/` + contract tests (below).

## 8. Alternatives considered and rejected

1. **Server proxy stripping `X-Frame-Options`/CSP** — serves hostile content from the app origin (Theia CVE class), breaks cookies/TLS origin guarantees, converts our server into an open relay. Rejected permanently.
2. **Separate-subdomain serving (Theia/Coder/Gitpod model)** — the correct fix *if* Garcon ever serves workspace HTML as browsable pages; irrelevant for framing third-party/localhost URLs, and Garcon's single-port deployment story makes wildcard subdomains a poor fit today. Recorded as the required approach if "preview workspace file as page" ever becomes a feature.
3. **Headless-browser streaming (screenshot/CDP)** — solves framing refusal but needs a browser runtime on the server, streaming, input proxying; massive scope, poor fidelity. The `agent-browser`/Lightpanda tooling remains for agents, not for this pane.
4. **`history.back()`-based navigation buttons (VS Code approach)** — unsafe outside webview isolation: can pop the SPA's own history. Replaced by committed-URL stack + remount.
5. **Multi-instance browser tabs in v1** — 10× machinery for a v1 nobody has used yet. Deferred with upgrade path (Section 13).
6. **`credentialless` iframe by default** — Chrome-only, silently logs users out of framed sites elsewhere. Future toggle at most.
7. **Wiring link capture via props through every Markdown consumer** — five call sites churn vs. one optional context; context chosen (matches `$lib/context` rule and keeps `/shared` untouched).

## 9. Known limitations (shipped as documented behavior)

- Sites sending anti-framing headers show an empty frame (banner in Phase 2); "Open externally" is the fallback. Expect this for most large consumer sites; the primary use cases — localhost dev servers and most docs sites — embed fine.
- Address bar shows the last committed URL, not in-frame navigation. Back/forward cover committed URLs only.
- In-frame clicks add joint-history entries (tab back button steps the frame before the app; platform behavior, harmless to SPA state).
- Framed sessions may be logged out (storage partitioning) on Safari/Firefox.
- `http://` non-loopback targets cannot load when Garcon is served over `https` (mixed content; inline warning).
- Global keyboard shortcuts pause while the frame has focus.
- Moving the tab between hosts reloads the page.

## 10. Execution plan

Ordered; each step independently shippable and validated. TypeScript exhaustiveness makes `bun run check` the safety net for missed sites in steps 1–2.

### Phase 0 — server hardening (independent of the feature)

**Step 0.1: security headers.** Files: `server/routes/static.ts`, `server/routes/files.ts`, `docs/security.md`.

```ts
// static.ts — extend staticHeaders (keep cacheHeaders as-is)
export function staticHeaders(requestPath: string, size: number): Headers {
  const headers = new Headers(cacheHeaders(requestPath));
  headers.set('Content-Length', String(size));
  headers.set('X-Content-Type-Options', 'nosniff');
  if (requestPath.endsWith('.html')) {
    // The app is never legitimately framed; embedded Browser-surface content is
    // cross-origin by policy, so denying framing here costs nothing.
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    headers.set('Referrer-Policy', 'same-origin');
  }
  return headers;
}
```

```ts
// files.ts handleContent — the response construction becomes:
return new Response(body, {
  headers: {
    'Content-Type': mimeType,
    [FILE_REVISION_HEADER]: revision,
    // Workspace bytes must never execute with app-origin authority if this
    // response is ever rendered as a document (e.g. direct navigation with
    // auth disabled). Fetch/blob consumers are unaffected by response CSP.
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  },
});
```

Tests: `server/routes/__tests__/static.test.js` — assert the four headers on `/index.html` and `nosniff`-only on an immutable asset; `server/routes/__tests__/files.test.js` — assert `content-security-policy: sandbox` + `nosniff` on a content read. Append the Section 6.5 rules to `docs/security.md`. Validate: `bun run test`. Risk: ~none (headers are additive); rollback = revert headers.

### Phase 1 — the Browser surface

**Step 1: type plumbing.** Files: `web/src/lib/workspace/surface-types.ts`, `common/workspace-layout.ts`, `web/src/lib/workspace/layout-schema.ts`.

```ts
// surface-types.ts
export const PORTABLE_SINGLETON_KINDS = [
  'git', 'git-history', 'git-compare', 'pull-requests', 'files', 'commit', 'browser',
] as const;
// portableSingletonDescriptor(): add
case 'browser':
  return { id: singletonSurfaceId(kind), type: 'singleton', kind };
```

```ts
// common/workspace-layout.ts
kind: 'git' | 'git-history' | 'git-compare' | 'pull-requests' | 'files' | 'commit' | 'browser';
```

```ts
// layout-schema.ts parseRef(): extend the kind check with
|| value.kind === 'browser'
```

Appending last keeps "Open Browser" below "New Terminal" in the taskbar dropdown (array order drives `otherClosedSingletonKinds`). Run `bun run check` — the remaining compile errors are the exact to-do list for steps 2, 5, 6.

**Step 2: controller registry.** File: `web/src/lib/workspace/singleton-surfaces.svelte.ts`.

```ts
import { BrowserSurfaceController } from '$lib/browser/browser-surface.svelte.js';
// SingletonControllerByKind: browser: BrowserSurfaceController;
// #visible initializer: browser: false,
// factories: browser: () => new BrowserSurfaceController(),
browser(): BrowserSurfaceController {
  return this.#controller('browser');
}
```

No `SingletonSurfaceRegistryDeps` change — the controller has no injected dependencies (like `FilesSurfaceController`). `workspace-services.ts` is untouched.

**Step 3: URL policy.** New file `web/src/lib/browser/browser-url.ts`.

```ts
// Normalizes and validates address-bar input for the Browser surface.
// Only http(s) targets are accepted, and the app's own origin is refused so
// framed content can never run same-origin with Garcon (see BROWSER_SURFACE_DESIGN.md).

export type BrowserUrlRejection = 'empty' | 'unparseable' | 'scheme' | 'userinfo' | 'same-origin';

export type BrowserUrlResult =
	| { ok: true; url: string }
	| { ok: false; reason: BrowserUrlRejection };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

// Naive loopback heuristic for scheme defaulting only (127.0.0.0/8 beyond
// 127.0.0.1 defaults to https); users can always type an explicit scheme.
function defaultScheme(input: string): 'http://' | 'https://' {
	if (input.startsWith('[')) return input.startsWith('[::1]') ? 'http://' : 'https://';
	const host = input.split(/[/:?#]/, 1)[0]?.toLowerCase() ?? '';
	return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') ? 'http://' : 'https://';
}

export function normalizeBrowserUrl(input: string, appOrigin: string): BrowserUrlResult {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, reason: 'empty' };
	const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
	const candidate = hasScheme ? trimmed : `${defaultScheme(trimmed)}${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return { ok: false, reason: 'unparseable' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
	if (url.username || url.password) return { ok: false, reason: 'userinfo' };
	if (url.origin === appOrigin) return { ok: false, reason: 'same-origin' };
	return { ok: true, url: url.href };
}

// Deterministic client-side check: an https-served app cannot frame plain-http
// non-loopback content (blockable mixed content).
export function isMixedContentBlocked(url: string, appOrigin: string): boolean {
	if (!appOrigin.startsWith('https:')) return false;
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:') return false;
	const host = parsed.hostname;
	return !(LOOPBACK_HOSTS.has(host) || host === '[::1]' || host.endsWith('.localhost'));
}
```

**Step 4: controller.** New file `web/src/lib/browser/browser-surface.svelte.ts`. Add `browserSurface: 'browser_surface_v1'` to `LOCAL_STORAGE_KEYS` in `web/src/lib/utils/local-persistence.ts`.

```ts
// Rune-backed state for the Browser surface: committed URL, address input,
// host-side navigation stacks, and iframe remount generation.
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { normalizeBrowserUrl, type BrowserUrlRejection } from './browser-url.js';

// Sandbox tokens are the security contract of the surface; change only with
// a BROWSER_SURFACE_DESIGN.md update. Deliberately absent: allow-top-navigation*.
export const BROWSER_IFRAME_SANDBOX =
	'allow-scripts allow-forms allow-same-origin allow-downloads allow-popups';

const MAX_STACK = 50;
const MAX_PERSISTED_URL_LENGTH = 8192;

export class BrowserSurfaceController implements PortableSingletonController {
	committedUrl = $state<string | null>(null);
	inputValue = $state('');
	// Incremented for every host navigation; the template keys the iframe on it
	// so committing a URL never appends to the joint session history.
	frameGeneration = $state(0);
	rejection = $state<BrowserUrlRejection | null>(null);
	canGoBack = $state(false);
	canGoForward = $state(false);

	// Session-only by design; only the committed URL persists.
	#back: string[] = [];
	#forward: string[] = [];
	readonly #appOrigin: string;

	constructor(appOrigin = typeof window === 'undefined' ? '' : window.location.origin) {
		this.#appOrigin = appOrigin;
		const restored = this.#readPersisted();
		if (restored) {
			this.committedUrl = restored;
			this.inputValue = restored;
		}
	}

	navigate(rawInput: string): boolean {
		const result = normalizeBrowserUrl(rawInput, this.#appOrigin);
		if (!result.ok) {
			this.rejection = result.reason;
			return false;
		}
		if (this.committedUrl && this.committedUrl !== result.url) {
			this.#back.push(this.committedUrl);
			if (this.#back.length > MAX_STACK) this.#back.shift();
			this.#forward = [];
		}
		this.#commit(result.url);
		return true;
	}

	reload(): void {
		if (this.committedUrl === null) return;
		this.rejection = null;
		this.frameGeneration += 1;
	}

	goBack(): void {
		const previous = this.#back.pop();
		if (previous === undefined) return;
		if (this.committedUrl) this.#forward.push(this.committedUrl);
		this.#commit(previous);
	}

	goForward(): void {
		const next = this.#forward.pop();
		if (next === undefined) return;
		if (this.committedUrl) this.#back.push(this.committedUrl);
		this.#commit(next);
	}

	clearRejection(): void {
		this.rejection = null;
	}

	setProjectState(_projectState: WorkspaceProjectState): void {}

	setPresentationVisible(_visible: boolean): void {}

	dispose(): void {
		this.rejection = null;
	}

	#commit(url: string): void {
		this.committedUrl = url;
		this.inputValue = url;
		this.rejection = null;
		this.frameGeneration += 1;
		this.canGoBack = this.#back.length > 0;
		this.canGoForward = this.#forward.length > 0;
		if (url.length <= MAX_PERSISTED_URL_LENGTH) {
			setLocalStorageItem(LOCAL_STORAGE_KEYS.browserSurface, JSON.stringify({ url }));
		}
	}

	#readPersisted(): string | null {
		try {
			const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.browserSurface);
			if (!raw) return null;
			const parsed: unknown = JSON.parse(raw);
			const url =
				parsed && typeof parsed === 'object' && 'url' in parsed ? (parsed as { url: unknown }).url : null;
			if (typeof url !== 'string') return null;
			return normalizeBrowserUrl(url, this.#appOrigin).ok ? url : null;
		} catch {
			return null;
		}
	}
}
```

Note the restore path re-validates through `normalizeBrowserUrl` — persisted state is a trust boundary (another tab or an old build may have written it).

**Step 5: surface component.** New file `web/src/lib/components/browser/BrowserSurface.svelte`. Skeleton (styling follows `FLOATING_*` toolbar idioms and semantic tokens; abbreviated to the structural contract):

```svelte
<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import {
		BROWSER_IFRAME_SANDBOX,
		type BrowserSurfaceController,
	} from '$lib/browser/browser-surface.svelte.js';
	import { isMixedContentBlocked } from '$lib/browser/browser-url.js';
	import * as m from '$lib/paraglide/messages.js';

	let { controller, visible }: { controller: BrowserSurfaceController; visible: boolean } = $props();

	const rejectionMessage = $derived.by(() => {
		switch (controller.rejection) {
			case 'scheme': return m.browser_url_rejected_scheme();
			case 'same-origin': return m.browser_url_rejected_same_origin();
			case 'userinfo':
			case 'unparseable': return m.browser_url_rejected_invalid();
			default: return null;
		}
	});
	const mixedContentBlocked = $derived(
		controller.committedUrl !== null &&
			isMixedContentBlocked(controller.committedUrl, window.location.origin),
	);

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		controller.navigate(controller.inputValue);
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<form class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5" onsubmit={submit}>
		<button type="button" aria-label={m.browser_back()} title={m.browser_back()}
			disabled={!controller.canGoBack} onclick={() => controller.goBack()}>
			<ArrowLeft class="h-3.5 w-3.5" />
		</button>
		<button type="button" aria-label={m.browser_forward()} title={m.browser_forward()}
			disabled={!controller.canGoForward} onclick={() => controller.goForward()}>
			<ArrowRight class="h-3.5 w-3.5" />
		</button>
		<button type="button" aria-label={m.browser_reload()} title={m.browser_reload()}
			disabled={controller.committedUrl === null} onclick={() => controller.reload()}>
			<RotateCw class="h-3.5 w-3.5" />
		</button>
		<input
			type="text"
			class="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1 text-base sm:text-sm"
			aria-label={m.browser_address_bar_label()}
			title={m.browser_address_shows_committed()}
			placeholder={m.browser_address_placeholder()}
			autocomplete="off" autocapitalize="off" spellcheck={false}
			bind:value={controller.inputValue}
			oninput={() => controller.clearRejection()}
		/>
		{#if controller.committedUrl}
			<a href={controller.committedUrl} target="_blank" rel="noopener noreferrer"
				aria-label={m.browser_open_external()} title={m.browser_open_external()}>
				<ExternalLink class="h-3.5 w-3.5" />
			</a>
		{/if}
	</form>

	{#if rejectionMessage}
		<div class="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground" role="alert">
			{rejectionMessage}
		</div>
	{:else if mixedContentBlocked}
		<div class="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground" role="alert">
			{m.browser_mixed_content_blocked()}
		</div>
	{/if}

	{#if controller.committedUrl === null}
		<div class="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
			<div>
				<p class="font-medium text-foreground">{m.browser_empty_state_title()}</p>
				<p class="mt-1 max-w-md">{m.browser_empty_state_hint()}</p>
			</div>
		</div>
	{:else}
		{#key controller.frameGeneration}
			<!-- bg-white mirrors the browser's default document canvas; framed pages
			     without their own background expect it. Not themed by design. -->
			<iframe
				title={m.browser_frame_title()}
				src={controller.committedUrl}
				sandbox={BROWSER_IFRAME_SANDBOX}
				referrerpolicy="no-referrer"
				allow="fullscreen"
				class="min-h-0 w-full flex-1 border-0 bg-white"
			></iframe>
		{/key}
	{/if}
</div>
```

(`visible` is currently unused but kept in the prop contract for parity with sibling surfaces and future pause behavior.) Button styling reuses the shared toolbar button classes at implementation time.

**Step 6: workspace wiring.** Files: `PortableSurfaceContent.svelte`, `WorkspaceTaskBar.svelte`, `WorkspaceRoot.svelte`, `CommandMenu.svelte`.

```ts
// PortableSurfaceContent.svelte module script
const browserRenderer = lazyRenderer(() => import('$lib/components/browser/BrowserSurface.svelte'));
```

```svelte
<!-- PortableSurfaceContent.svelte, before the closing of the singleton chain;
     no ProjectSurfaceGate: the surface is project-independent -->
{:else if surface.type === 'singleton' && surface.kind === 'browser'}
	{@const controller = singletonSurfaces.browser()}
	{#await browserRenderer() then BrowserSurface}
		<BrowserSurface {controller} {visible} />
	{/await}
```

```ts
// WorkspaceTaskBar.svelte
import Globe from '@lucide/svelte/icons/globe';
// singletonLabels: browser: m.workspace_surface_browser,
// icon snippet: {:else if kind === 'browser'}<Globe class="h-3.5 w-3.5 shrink-0" />
```

```ts
// WorkspaceRoot.svelte label map (line ~261): browser: m.workspace_surface_browser(),
```

```ts
// CommandMenu.svelte, after the workspace-commit entry
{
	id: 'workspace-browser',
	label: m.workspace_surface_browser(),
	description: m.command_open_panel({ panel: m.workspace_surface_browser() }),
	category: categories.workspace,
	action: () =>
		void (workspace.isMobile
			? workspace.focusMobileSingleton('browser')
			: workspace.openSingleton('browser', 'main')),
},
```

No changes needed in `canonical-layout.ts` (browser is not canonical), `mobile-presentation-planner.ts`/`TRANSIENT_MOBILE_SINGLETON_KINDS` (not transient), `visible-presentations.ts`, or the surface-frame registry (all id/kind-generic). `bun run check` proves the claim.

**Step 7: local setting.** Files: `web/src/lib/stores/local-settings.svelte.ts`, `web/src/lib/components/settings/LocalSettingsSection.svelte`.

`local-settings.svelte.ts` — six mechanical additions following `allowDirectChats` exactly: snapshot interface `openLinksInBrowserSurface: boolean;`, `BooleanLocalSettingKey` union member, `DEFAULTS.openLinksInBrowserSurface: false`, `parseFromRaw` entry via `parseBoolean`, class `$state` field, `snapshot()`/`#apply()` entries.

```svelte
<!-- LocalSettingsSection.svelte, after the allowDirectChats row -->
{@render settingRow(
	m.settings_open_links_in_browser(),
	ls.openLinksInBrowserSurface,
	() => ls.toggle('openLinksInBrowserSurface'),
	{ description: m.settings_open_links_in_browser_description() },
)}
```

**Step 8: link capture.** Files: `web/src/lib/browser/external-link-policy.ts`, `web/src/lib/browser/browser-link-opener.ts`, `web/src/lib/context/index.ts`, `web/src/routes/+layout.svelte`, `web/src/lib/components/chat/Markdown.svelte`.

```ts
// external-link-policy.ts
// Cross-cutting policy for external (http/https) link clicks in rendered markdown.
export interface ExternalLinkPolicy {
	/** Returns true when the click was handled in-app and default navigation must be prevented. */
	openExternalLink(href: string): boolean;
}
```

```ts
// browser-link-opener.ts
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
import type { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte';
import { normalizeBrowserUrl } from './browser-url.js';
import type { ExternalLinkPolicy } from './external-link-policy.js';

// Routes captured links into the Browser surface when the local setting is on.
// Any rejection falls back to default new-tab navigation, so capture can never
// break a link.
export class BrowserLinkOpener implements ExternalLinkPolicy {
	constructor(
		private readonly deps: {
			readonly settings: LocalSettingsStore;
			readonly workspace: WorkspaceCoordinator;
			readonly surfaces: SingletonSurfaceRegistry;
		},
	) {}

	openExternalLink(href: string): boolean {
		if (!this.deps.settings.openLinksInBrowserSurface) return false;
		const result = normalizeBrowserUrl(href, window.location.origin);
		if (!result.ok) return false;
		this.deps.surfaces.browser().navigate(result.url);
		if (this.deps.workspace.isMobile) {
			void this.deps.workspace.focusMobileSingleton('browser');
		} else {
			void this.deps.workspace.openSingleton('browser', 'sidebar');
		}
		return true;
	}
}
```

```ts
// context/index.ts (with the other root contexts)
import type { ExternalLinkPolicy } from '$lib/browser/external-link-policy.js';
const [getRequiredExternalLinkPolicy, setExternalLinkPolicyContext] =
	createContext<ExternalLinkPolicy>();
export const setExternalLinkPolicy = setExternalLinkPolicyContext;
export function getOptionalExternalLinkPolicy(): ExternalLinkPolicy | null {
	try {
		return getRequiredExternalLinkPolicy();
	} catch {
		return null;
	}
}
```

`+layout.svelte`: after the existing `setLocalSettings`/`setWorkspaceCoordinator`/`setSingletonSurfaces` calls, construct and set `new BrowserLinkOpener({ settings, workspace, surfaces })` via `setExternalLinkPolicy`.

```svelte
<!-- Markdown.svelte instance script -->
import { getOptionalExternalLinkPolicy } from '$lib/context';
const externalLinkPolicy = getOptionalExternalLinkPolicy();

function handleExternalClick(event: MouseEvent, href: string): void {
	if (!externalLinkPolicy) return;
	if (event.defaultPrevented || event.button !== 0) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	if (externalLinkPolicy.openExternalLink(href)) event.preventDefault();
}
```

```svelte
<!-- link snippet: replace the conditional onclick with -->
onclick={(e: MouseEvent) => {
	if (isFile || isAbsPath) {
		e.preventDefault();
		if (isFile) onLinkNavigate?.({ rawHref: href ?? '', kind: parsed.kind });
		return;
	}
	handleExternalClick(e, href ?? '');
}}
```

`target="_blank" rel="noopener noreferrer"` stay on the anchor: middle-click, modifier-click, and every rejection path keep today's behavior. `/shared` renders without the context → getter returns `null` → untouched.

**Step 9: i18n.** File: `web/messages/en.json`, then regenerate Paraglide (`cd web && bunx @inlang/paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide`).

```jsonc
"workspace_surface_browser": "Browser",
"browser_frame_title": "Embedded browser content",
"browser_address_bar_label": "Address",
"browser_address_placeholder": "Enter a URL, e.g. localhost:5173",
"browser_address_shows_committed": "Shows the last address opened here; navigation inside the page is not tracked",
"browser_back": "Back",
"browser_forward": "Forward",
"browser_reload": "Reload",
"browser_open_external": "Open in new tab",
"browser_empty_state_title": "Open a page",
"browser_empty_state_hint": "Preview local dev servers or docs beside your chat. Some sites refuse to be embedded; use Open in new tab for those.",
"browser_url_rejected_scheme": "Only http and https URLs can be opened here.",
"browser_url_rejected_same_origin": "Garcon can't embed its own pages. Open this in a new tab instead.",
"browser_url_rejected_invalid": "That doesn't look like a URL that can be opened.",
"browser_mixed_content_blocked": "This http page can't load inside an https app. Open it in a new tab instead.",
"browser_embed_blocked_banner": "This site refuses to be embedded. Open it in a new tab.",
"settings_open_links_in_browser": "Open web links in Browser tab",
"settings_open_links_in_browser_description": "Open external links from chats and markdown in the in-app Browser instead of a new browser tab. Modifier-clicks still open a new tab."
```

### Phase 2 — embed-check advisory

**Step 10: endpoint + client + banner.** Files: `common/browser-embed.ts` (new), `server/routes/browser.ts` (new), `server/routes/index.ts` (register), `web/src/lib/api/browser.ts` (new), controller/component additions.

```ts
// common/browser-embed.ts
export type EmbedVerdict = 'embeddable' | 'blocked' | 'restricted' | 'unreachable';

export interface EmbedCheckResponse {
	verdict: EmbedVerdict;
}
```

```ts
// server/routes/browser.ts (shape; follow route-helpers/json conventions)
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;

// Cookieless advisory probe of framing headers. Reports a verdict only; never
// echoes response bodies. The client treats it as a hint, not a gate.
async function handleEmbedCheck(_request: Request, url: URL): Promise<Response> {
  const target = url.searchParams.get('url');
  if (!target) return Response.json({ error: 'Missing url' }, { status: 400 });
  let current: URL;
  try {
    current = new URL(target);
  } catch {
    return Response.json({ error: 'Invalid url' }, { status: 400 });
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return Response.json({ error: 'Unsupported scheme' }, { status: 400 });
    }
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return Response.json({ verdict: 'unreachable' });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      current = new URL(location, current);
      continue;
    }
    const verdict = framingVerdict(response.headers);
    await response.body?.cancel();
    return Response.json({ verdict });
  }
  return Response.json({ verdict: 'unreachable' });
}

function framingVerdict(headers: Headers): EmbedVerdict {
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return 'blocked';
  const csp = headers.get('content-security-policy') ?? '';
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith('frame-ancestors'));
  if (directive) {
    const sources = directive.slice('frame-ancestors'.length).trim().toLowerCase();
    if (sources === "'none'") return 'blocked';
    if (sources !== '*') return 'restricted';
  }
  return 'embeddable';
}

export const browserRoutes = {
  '/api/v1/browser/embed-check': { GET: handleEmbedCheck },
};
```

Client: `checkEmbeddable(url)` in `web/src/lib/api/browser.ts` using `authenticatedFetch` + `ApiError` conventions; `BrowserSurfaceController.navigate` fires it without awaiting and sets `embedVerdict = $state<EmbedVerdict | null>(null)` guarded by a navigation sequence number (stale responses dropped); component shows `browser_embed_blocked_banner` for `blocked`/`restricted`. Contract tests per WS/API discipline.

## 11. Test plan

Web unit/component (run: `cd web && bun run test`; also `bun run check`, `bun run lint`):

| File | Cases |
| --- | --- |
| `web/src/lib/browser/__tests__/browser-url.logic.test.ts` (new; DOM-free, origin passed as arg) | bare domain → `https://`; `localhost:5173`/`127.0.0.1`/`[::1]:3000`/`foo.localhost` → `http://`; explicit schemes preserved; rejects `javascript:alert(1)`, `data:text/html,x`, `file:///etc/passwd`, `about:blank`; rejects `https://user:pw@host`; rejects exact app origin, accepts same host different port; empty/whitespace → `empty`; garbage → `unparseable`; `isMixedContentBlocked` matrix (https app + http public → true; http app → false; loopback → false). |
| `web/src/lib/browser/__tests__/browser-surface.test.ts` (new) | navigate commits + syncs input + bumps generation + persists; rejection sets `rejection` and leaves committed state; reload bumps generation only; back/forward stack transitions incl. `canGoBack/canGoForward`; stack cap; restore from storage; restore re-validates (poisoned storage with `javascript:` → ignored); dispose keeps persisted URL. |
| `web/src/lib/browser/__tests__/browser-link-opener.test.ts` (new) | setting off → `false`, no calls; non-http/same-origin href → `false`; success → controller navigated + `openSingleton('browser','sidebar')`; mobile → `focusMobileSingleton`. Doubles via `satisfies Pick<WorkspaceCoordinator, 'isMobile' \| 'openSingleton' \| 'focusMobileSingleton'>` etc. (repo test-double rule). |
| `web/src/lib/components/browser/__tests__/BrowserSurface.test.ts` (new) | empty state renders; submit → iframe present with exact `sandbox`, `referrerpolicy`, `title`, `allow` attributes (regression-pins the security contract); rejection banner text per reason; external anchor `href`/`rel`/`target`; reload remounts (element identity changes); mixed-content banner. |
| `web/src/lib/components/chat/__tests__/markdown.test.ts` (extend) | with policy context returning true → `preventDefault` called, href passed; policy returning false → default kept; ctrl/meta-click bypasses policy; file links unaffected; without context → behavior identical to today (existing cases keep passing). |
| `web/src/lib/stores/__tests__/local-settings.test.ts` (extend) | default false; toggle persists; parse tolerates absence/garbage. |
| `web/src/lib/workspace/__tests__/layout-schema.test.ts` (extend) | browser ref round-trips in main and sidebar; unknown kind still dropped. |
| `web/src/lib/workspace/__tests__/singleton-surfaces.test.ts` (extend) | `browser()` constructs once, reuses, disposes on `disposeSurface('browser')`. |
| `web/src/lib/workspace/__tests__/workspace-coordinator.test.ts` (extend) | `openSingleton('browser','main')` registers + focuses (mirror an existing kind's case). |
| `web/src/lib/components/workspace/__tests__/WorkspaceTaskBar.test.ts` (extend) | dropdown lists "Open Browser" after the New Terminal item when closed; hidden when open. |

Server (run: `bun run test` at root):

| File | Cases |
| --- | --- |
| `server/routes/__tests__/static.test.js` (extend) | `/index.html` response carries `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'`, `referrer-policy: same-origin`, `x-content-type-options: nosniff`; asset responses carry `nosniff` and no XFO. |
| `server/routes/__tests__/files.test.js` (extend) | content endpoint carries `content-security-policy: sandbox` + `nosniff`; revision header unchanged. |
| `server/routes/__tests__/browser-embed-check.test.js` (new, Phase 2) | verdicts against a local fixture `Bun.serve` returning each header shape (`DENY`, `sameorigin`, `frame-ancestors 'none'`, `frame-ancestors https:`, none); redirect following + hop cap; non-http scheme → 400; missing url → 400; unreachable host → `unreachable`; auth required (401 without token) — contract-tests the new API per repo discipline. |

E2E (`integration-tests/tests/e2e/browser-surface.test.ts`, new; best-effort given Lightpanda's partial iframe rendering — assertions are DOM-attribute level, not painted-frame level): open Command Menu → "Browser"; type a fixture-server URL → iframe exists with expected `src` and exact sandbox string; type the app's own origin → same-origin rejection banner, no iframe src change. If Lightpanda cannot express this, drop to the component test and note it in the PR (residual risk: no full-stack proof of the settings/persistence handshake; covered piecewise by unit tests).

Intentionally omitted: automated tests for third-party sites' framing behavior (network-dependent, flaky by design — the embed-check fixture tests cover the logic); joint-history remount behavior (browser-internal; manually verified below).

## 12. Manual verification (pre-merge, per repo checklist)

1. Open Browser from the taskbar popup (below New Terminal) into main and sidebar; rapid-switch chats while it is open — no dock/composer layout shift, no focus/scroll jump.
2. Navigate to a local dev server; click links inside the frame; confirm the app's back button first unwinds in-frame clicks and SvelteKit state is unaffected; confirm address-bar Go/Enter and toolbar reload never grow the tab history.
3. Type `https://github.com` — blank frame (refusal); "Open in new tab" works. Phase 2: banner appears.
4. Type the Garcon origin — rejection banner.
5. Enable the setting; plain-click a chat link → opens in sidebar Browser; cmd/ctrl-click → new tab; `/shared` page links unchanged.
6. Reload Garcon — tab and URL restored. Close tab, reopen — URL restored.
7. Mobile viewport: Command Menu → Browser; address input does not zoom on focus (≥16px), toolbar reachable.
8. Keyboard-only pass over the toolbar; `focus-visible` rings visible.
9. `bun run start --port 0` boots (never touch the user's running server).

## 13. Future work (explicitly deferred)

- **Multi-instance tabs**: new descriptor `{ id, type: 'browser', browserId }`, a `BrowserSessionRegistry` keyed like file sessions, persistence of per-instance URLs in the layout ref, and a "New Browser" (vs "Open Browser") menu item. The singleton kind remains as the migration source.
- Embed-check verdict cache and a "why is this blank?" inspector.
- `allow-storage-access-by-user-activation` for SSO-in-frame on partitioning browsers; optional `credentialless` "fresh session" toggle (Chrome-only).
- Focus-lock indicator (VS Code-style) when the frame holds keyboard focus.
- Per-project home URL / pinned URLs; agent tool to open a URL in the user's Browser surface.
- `Origin`-allowlist hardening for mutating routes in `authDisabled` mode (independent security issue surfaced by this review).

## 14. Resolved decisions, assumptions, deferred risks

Resolved (defaults chosen; cheap to veto before implementation starts):

1. Singleton surface v1, menu label "Open Browser" via the existing `workspace_open_surface` pattern — not terminal-style multi-instance (Section 5.1, 13).
2. Sandbox set of Section 5.2 (VS Code parity plus `allow-popups`, but **not** `allow-popups-to-escape-sandbox`) is the security contract, pinned by component and e2e tests.
3. Same-origin URLs are refused in the surface; `CSP: sandbox` added to `/api/v1/files/content`; `frame-ancestors 'none'`/XFO on **every** app HTML document, `/shared/:token` included (revised during review — see Section 15).
4. Link capture scope = everything rendered through `Markdown.svelte` (chat + markdown viewer), plain left-click only, `sidebar` placement, default off.
5. Back/forward = host-side committed-URL stack; every host navigation remounts the iframe; no joint-history manipulation.
6. Embed-check probe is Phase 2 and advisory-only; v1 ships with honest hint copy.
7. URL persists globally (not per-project) under `browser_surface_v1`.

Verified facts vs. assumptions: everything in Section 3 was read from source this session; Section 4 external claims carry links; the only unverified-by-execution assumptions are (a) Lightpanda's iframe DOM support for the e2e test (fallback defined) and (b) exact shared-toolbar-class names to reuse in `BrowserSurface.svelte` (cosmetic, resolved at implementation).

Deferred risks (accepted, documented in Section 9): address-bar drift from in-frame navigation; refusal-is-a-blank-frame UX until Phase 2; framed-session logouts on partitioning browsers; frame focus swallowing global shortcuts.

## 15. Implementation notes (deltas from the plan above)

Recorded after implementation on branch `iframe-browser` (base: `origin/main` 9dd96582):

- Upstream renamed the taskbar menu derivations (`otherAvailableSingletonKinds`) and offers open-in-other-host singletons as move actions via `openSingletonInHost`; the `browser` kind slots into that newer loop unchanged, and `manualFullscreen` became `fullscreenHost` in layout snapshots.
- `normalizeBrowserUrl` gained address-bar disambiguation the plan missed: `localhost:5173` is a *valid scheme* to the URL parser, so a colon followed by port-like digits (`^\d+([/?#]|$)`) is treated as host:port rather than a scheme (`hasExplicitScheme` in `web/src/lib/browser/browser-url.ts`).
- Phases 1 and 2 landed together: the controller takes an injectable `EmbedProbe` (default adapts `checkEmbeddable` from `web/src/lib/api/browser.ts`, `null` disables) with a navigation sequence guard against stale verdicts; `dispose()` also bumps the sequence.
- `BrowserSurface.svelte` takes only `controller` (no `visible` prop — nothing consumed it), carries `data-browser-surface-form`/`data-browser-surface-frame` hooks for the Lightpanda driver, and has no separate Go button (Enter submits the address form; reload covers the rest).
- The embed-check route also hardens `framingVerdict` for comma-joined repeated headers (`X-Frame-Options: SAMEORIGIN, DENY`, multiple CSP policies) and ignores report-only CSP; covered in `server/routes/__tests__/browser-embed-check.test.js` against a local `Bun.serve` fixture.
- Adversarial review (three independent agents) corrected the security model: the
  "guaranteed cross-origin" premise was **not** durable, because a framed page can
  navigate itself (or be redirected) to an app-origin URL, which the client-side
  same-origin refusal cannot see. `/shared/:token` was the one app document still
  frameable (it builds its own `Response` and so missed `staticHeaders`), and it
  boots the full SPA. Fixed by extracting `applyAppDocumentSecurityHeaders()` and
  applying it there too; Sections 2 and 6 now state the two-layer invariant. No
  exploit existed (no script-injection gadget was found in the share page), but the
  documented invariant is now actually true.
- Link capture was live on `/shared/:token`: the root layout sets every context,
  including for public routes, so the design's "context absent on `/shared`"
  assumption was false and plain clicks there were swallowed into an invisible
  surface. `BrowserLinkOpener` now takes a getter-backed `workspacePresented` dep.
- `browser` is transient on mobile like `commit` (the precedent Section 5.8 cited
  was miscited: `commit` *is* transient). Without it the bottom bar stayed visible
  highlighting "Chat" and back would not exit the surface.
- The embed-check response is verdict-only; `status`/`finalUrl` were unused by the
  client and are no longer returned. `framingVerdict` now takes the most
  restrictive `frame-ancestors` across all delivered policies rather than the
  first, and the route gained a guard so framed content cannot drive the probe
  when auth is disabled. (That guard was initially `Sec-Fetch-*`; cycle 3
  replaced it with the required header described below.)
- The address input uses `sm:pointer-fine:text-sm`, not `sm:text-sm`, so touch
  devices at ≥640px (tablets, landscape phones) keep the 16px iOS-zoom floor —
  matching the `input.svelte` / `SidebarProjectPathDialog` idiom.
- The restore path probes the restored URL and returns the *normalized* href;
  over-long URLs clear stale persistence instead of leaving an older entry.
- Review cycle 2 removed `allow-popups-to-escape-sandbox` (an escaped popup is
  unsandboxed and can navigate `opener.top`, defeating the no-top-navigation
  rule), replaced the `Sec-Fetch-*` probe guard with a required
  `X-Garcon-Embed-Check` header (fetch metadata is omitted for non-trustworthy
  origins, so the guard was silently absent on plain-HTTP LAN deployments),
  rewrote `framingVerdict` to match CSP3 enforcement (per-policy first
  directive, exact directive name, and `frame-ancestors` superseding
  `X-Frame-Options`), and made probe sequencing claim its sequence before skip
  checks and defer by a microtask so a same-tick navigation supersedes it.
- Review cycle 2 also caught that making `browser` transient on mobile hid the
  bottom bar without giving it an exit: the frame chrome's Back/Close was
  `commit`-only. `PortableSurfaceFrame` now renders it for `browser` too.
- happy-dom really fetches iframe documents and follows link-click navigations, and per-file `@vitest-environment-options` docblocks are ignored under the project-based vitest config (verified empirically). Component tests therefore commit RFC 5737 TEST-NET URLs (`192.0.2.x`) so no test ever touches a routable network. The markdown test host wraps the policy in a closure to avoid Svelte's `state_referenced_locally` warning.

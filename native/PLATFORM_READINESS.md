# Native Platform Gates

The native packages remain previews. A package build, a valid container, and a
successful process launch are distinct from workflow qualification and signed
distribution. No release workflow, signing credentials, store upload, or update
channel is enabled by these gates.

## Android Loading Blocker

Pinned inputs: Tauri Rust 2.12.5, Tauri CLI 2.12.4, Wry 0.57.1, from the tracked
lockfiles. The installed Wry crate's `RustWebViewClient.kt` was byte-compared with
its recorded source revision below. The Android host continues to reject
`connect_server` before URL parsing, persistence, or navigation. Startup also
rejects before reading saved settings. No debug, saved-selection, or runtime
configuration override enables Android connections.

Evidence:

- Wry installs its own client during WebView construction:
  [main_pipe.rs:268](https://github.com/tauri-apps/wry/blob/2446feadae623d6f2ac8d2136e3ccef3d7197e0e/src/android/main_pipe.rs#L268).
- Navigation calls Rust only from `shouldOverrideUrlLoading`:
  [RustWebViewClient.kt:65](https://github.com/tauri-apps/wry/blob/2446feadae623d6f2ac8d2136e3ccef3d7197e0e/src/android/kotlin/RustWebViewClient.kt#L65).
  Android explicitly excludes POST requests:
  [WebViewClient.java:81](https://github.com/aosp-mirror/platform_frameworks_base/blob/1cdfff555f4a21f71ccc978290e2e212e2f8b168/core/java/android/webkit/WebViewClient.java#L81).
- Wry's resource callback is Android `shouldInterceptRequest`:
  [RustWebViewClient.kt:30](https://github.com/tauri-apps/wry/blob/2446feadae623d6f2ac8d2136e3ccef3d7197e0e/src/android/kotlin/RustWebViewClient.kt#L30).
  Android invokes it only for the initial URL, not redirect destinations:
  [WebViewClient.java:215](https://github.com/aosp-mirror/platform_frameworks_base/blob/1cdfff555f4a21f71ccc978290e2e212e2f8b168/core/java/android/webkit/WebViewClient.java#L215).
  Combining these callbacks does not establish a POST 307/308 redirect boundary.
- Tauri `on_web_resource_request` operates on responses served by its own
  protocol, not arbitrary remote HTTP navigation:
  [protocol/tauri.rs:188](https://github.com/tauri-apps/tauri/blob/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri/src/protocol/tauri.rs#L188).
  `with_webview` exposes a JNI handle, not an additional request-decision API:
  [webview/mod.rs:235](https://github.com/tauri-apps/tauri/blob/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri/src/webview/mod.rs#L235).

Replacing the client over JNI with those same callbacks cannot fill their
platform-level gaps. A broad HTTP proxy would change cookies, TLS, bodies,
streaming, and browser networking ownership; it is not an acceptable guard.
Injected JavaScript, `onPageStarted`, and stopping after load are not pre-load
boundaries. No such workaround is installed.

Enabling Android requires a supported pre-network decision point covering every
document request and redirect, installed before the first possible remote load
and re-established before activity restoration. That remains an upstream/API
blocker, not a TODO to bypass in the chooser.

## Android Regression Harness

`android-tests/NavigationBoundaryTest.kt` contains two deliberately separate gates:

- Real Tauri host: disabled launcher, direct `connect_server` IPC denial, zero
  destination requests, and the same checks after `ActivityScenario.recreate()`.
- Isolated Android WebView probes: direct form POST escapes the navigation-only
  callback; 307/308 retain the POST body and escape a combined navigation/partial
  interception callback to both sibling mounts and another origin. These tests
  expect the documented vulnerability. A future platform fix fails the probe and
  calls for re-audit, not automatic connection enablement. JavaScript here only
  drives adversarial forms; it is never a guard.

The probes use Android's actual WebView, but do not claim to exercise a replacement
Wry client. The host test uses the actual generated Tauri activity and Rust IPC.
All HTTP fixtures are synthetic, bind `0.0.0.0`, and use device loopback.

The host scenario intentionally remains open until instrumentation reports its
results: destroying the last Tauri activity exits the shared app/test process.
The test-only runner argument `waitForActivitiesToComplete=false` disables both
AndroidX's [per-test activity finisher](https://github.com/android/android-test/blob/6de0b804ca086a6194a108ef2988fa6104eea96d/runner/android_junit_runner/java/androidx/test/runner/AndroidJUnitRunner.java#L502-L515)
and its [final activity cleanup](https://github.com/android/android-test/blob/6de0b804ca086a6194a108ef2988fa6104eea96d/runner/monitor/java/androidx/test/runner/MonitoringInstrumentation.java#L390-L415)
without changing assertion or result reporting. Run this harness only on a
dedicated disposable emulator, which owns residual cleanup. Only one test
launches the Tauri activity; adding another scenario requires isolated execution
because a new launch can destroy the retained activity. This gate does not
qualify orderly final activity destruction.

After the normal Android build, from `native/`:

```sh
bun run test:android:prepare
src-tauri/gen/android/gradlew -p src-tauri/gen/android \
  :app:assembleUniversalDebugAndroidTest -x :app:rustBuildUniversalDebug \
  --no-daemon --max-workers=1
# With a dedicated x86_64 emulator running:
src-tauri/gen/android/gradlew -p src-tauri/gen/android \
  :app:connectedUniversalDebugAndroidTest -x :app:rustBuildUniversalDebug \
  --no-daemon --max-workers=1
```

The Rust aggregate task is excluded only because the exact debug host was already
built by Tauri; direct Gradle invocation lacks the CLI's active Rust build bridge.
Do not skip the preceding APK build. The workflow runs API 35/google_apis with a
real system WebView. This is not qualification of every supported Android API or
WebView version, release builds, process death, or physical devices.

The preparation script is a tracked, deterministic, idempotent post-generation
step. It verifies the generated namespace, adds a test-only Gradle script, and
copies tracked instrumentation sources. No manual edit under ignored `gen/` is
required. Production manifests, activities, Wry clients, and network policy are
unchanged. Rerun preparation after any `android init` regeneration.

## Platform Matrix

| Platform | Automated gate | Remaining qualification |
| --- | --- | --- |
| Linux x64 | Existing real WebView transport/security smoke; host tests; package checks | Real Garcon workflows, signed delivery/update policy |
| Windows x64 | Host tests; unsigned NSIS build/container check | All interaction; Authenticode/update policy |
| macOS arm64/x64 | Host tests; unsigned DMG build/container check | All interaction; Developer ID/notarization/update policy |
| Android | Debug APK signature/identity/ABI check; CI emulator host-denial and callback-gap tests | Complete loading guard; device/process-death/workflow coverage; stable signing |
| iOS | Simulator metadata/binary checks; CI isolated launch/relaunch with screenshots | Actual interactions, device signing, device testing, TestFlight/App Store |

Android instrumentation and iOS native gates are configured for CI but unrun on this Linux VM. Java/Android
SDK/emulator and Xcode/macOS are absent. Their success must not be inferred from
Linux tests. The iOS launch gate creates and deletes only its own simulator;
it checks early process exits and captures images, not login, navigation, visual
correctness, or background/resume behavior. Screenshots require review.

Every platform still needs real Garcon login/streaming, large-PR review,
switch/recovery, attachments/downloads, terminal/clipboard/keyboard, TLS errors,
background/resume, and upgrade/cache testing. Browser and Local/remote executor
semantics are unchanged. Mobile push is a separate capability milestone.

## Distribution Preflight

From `native/`, `bun run distribution preview <target>` requires exactly one
artifact of each expected format. Targets are the four desktop Rust triples,
`android`, and `ios-simulator`. Desktop output honors `CARGO_TARGET_DIR`.

The preflight rejects missing, empty, symlinked, ambiguous, and incorrectly
identified containers and writes `artifacts/distribution-<target>.json` with
size, SHA-256, package version, preview signing status, required runtime gate,
and explicit release blockers. Container magic is not a full installer validation
or proof of authenticity. Runtime results are explicitly not attested by this
script. CI uploads the manifest with packages only after their gates succeed.

Android additionally runs pinned Build Tools 37.0.0 `apksigner verify` and `aapt`,
checks package/version/debug status, and requires arm64/x86_64 host libraries.
The manifest records the verified public signer-certificate SHA-256 so artifacts
from different ephemeral keys are distinguishable. Signature integrity does not
make an ephemeral debug key a stable identity.
The pinned Build Tools 37 signer labels identify V1, V2, or V3.0 certificates;
the single-certificate manifest rejects multiple, SDK-range rotation, and hybrid
signers rather than selecting one identity from several.
iOS archiving checks bundle identifier, version, executable, simulator platform,
and Mach-O build platform before creating the archive; device apps are rejected.
Debian packages also pass `dpkg-deb` content/version/architecture checks, DMGs pass
`hdiutil verify`, and simulator archives pass ZIP integrity checks. These do not
replace installation or signature/notarization verification.

`bun run distribution release <target>` always fails with the outstanding gates.
It never reads signing credentials and cannot publish. Before implementing an
actual release pipeline, the owner must provision stable inputs separately:

- Android: persist one protected keystore and alias; supply passwords only through
  protected secret inputs; pin the expected public certificate SHA-256; verify the
  produced APK certificate matches it. Never generate a fresh release key in CI
  or silently substitute a debug key. Verify same-key upgrades preserve app data.
- Windows: stable Authenticode identity and trusted timestamping; verify the
  installer signature and publisher after signing.
- macOS: Developer ID identity, notarization authorization, hardened-runtime and
  entitlement review; verify/staple the notarization ticket on the final artifact.
- iOS: matching team, distribution certificate, provisioning profile, bundle ID,
  device archive/export options, and separately authorized TestFlight/App Store
  delivery. A simulator zip is never an IPA.

No credentials were requested or accessed. None of these external milestones,
including notarization, TestFlight, physical devices, or mobile push, is complete.

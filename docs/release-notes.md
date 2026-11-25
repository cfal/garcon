## Canvas: Save Unsaved Changes Before Upgrading

Before upgrading from a build with tab-only Canvas recovery, reopen each Canvas with unsaved changes in the original tab or app window while it is still running the old client. Wait for **Saved**. If a save conflict prevents that, use **Save as copy** and confirm the copy shows **Saved**. Do this before reloading, closing the tab or window, or logging out. Canvases already saved to the server are unaffected.

If you've already upgraded, the new client cannot safely display, copy, export, or assign old recovery drafts to anyone, even in the same tab. Those drafts do not identify who wrote them. Upgrading does not erase them, but logging out clears local Canvas recovery drafts in both formats.

## Downloads And Qualification

Server archives: Linux x64 and Windows x64. Standalone CLI: Linux x64. Linux executable runtime smoke is required; the Windows server is build-only.

All `garcon-native-preview-*` downloads are engineering previews, not signed production distributions. Each ZIP contains the original package(s), `distribution-<target>.json` with qualification blockers, and LICENSE. Desktop packages are unsigned; macOS packages are not notarized and can be blocked by Gatekeeper. Android is a build-only universal debug APK with connections disabled and an ephemeral signing key, not a stable upgrade channel. iOS is a simulator archive matching its builder architecture, not a device IPA.

Extract ZIPs before use. AppImages require executable permission (`chmod +x`). Verify downloaded bytes using `SHA256SUMS` and GitHub artifact attestations. Provenance verifies build origin, not signing, reproducibility, or native workflow qualification. See `docs/releases.md` and `native/PLATFORM_READINESS.md` in the included source archive.

Docker version tags are promoted by a separate workflow after human publication, only after both amd64 and arm64 runtime smokes pass. Wait for that workflow before pulling the new exact version tag. Pin deployments to the reported image digest.

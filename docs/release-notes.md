## Downloads And Qualification

Server archives: Linux x64 and Windows x64. Standalone CLI: Linux x64. Linux executable runtime smoke is required; the Windows server is build-only.

All `garcon-native-preview-*` downloads are engineering previews, not signed production distributions. Each ZIP contains the original package(s), `distribution-<target>.json` with qualification blockers, and LICENSE. Desktop packages are unsigned; macOS packages are not notarized and can be blocked by Gatekeeper. Android is a build-only universal debug APK with connections disabled and an ephemeral signing key, not a stable upgrade channel. iOS is a simulator archive matching its builder architecture, not a device IPA.

Extract ZIPs before use. AppImages require executable permission (`chmod +x`). Verify downloaded bytes using `SHA256SUMS` and GitHub artifact attestations. Provenance verifies build origin, not signing, reproducibility, or native workflow qualification. See `docs/releases.md` and `native/PLATFORM_READINESS.md` in the included source archive.

Docker version tags are promoted by a separate workflow after human publication, only after both amd64 and arm64 runtime smokes pass. Wait for that workflow before pulling the new exact version tag. Pin deployments to the reported image digest.

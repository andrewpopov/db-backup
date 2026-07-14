# Releasing

Releases are deliberate and local-first: this repository has no required hosted
CI checks. Before opening the release pull request or creating a tag, run:

```bash
npm ci
npm run verify
npm audit --audit-level=high
```

Then bump `package.json`, add the matching changelog entry, merge the reviewed
pull request, and create an annotated `vX.Y.Z` tag. When npm publishing is
enabled, publish only from that tag with an account protected by 2FA. Use npm
provenance only after a trusted-publishing path is configured; do not claim it
otherwise. Finally, install the published package into a clean consumer and
verify its exported API before announcing the release.

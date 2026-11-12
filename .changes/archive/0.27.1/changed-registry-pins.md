---
kind: changed
summary: Resolve @andrewpopov dependencies from the fleet registry
---

Installs now resolve the `@andrewpopov` runtime dependency from the fleet registry at `https://npm.tail615381.ts.net/` through a committed `.npmrc`, pinned to the same exact version as before, instead of a `github:andrewpopov/<kit>#<tag>` git ref. There is no behaviour change, but a consumer installing this version needs the `@andrewpopov` registry `.npmrc` (`@andrewpopov:registry=https://npm.tail615381.ts.net/`) and tailnet access to resolve that dependency.

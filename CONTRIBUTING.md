# Contributing

Thanks for improving this package. Open an issue before substantial changes so
the public API and compatibility impact can be discussed.

## Local checks

Use the Node version declared in `package.json`, then run:

```bash
npm ci
npm run verify
npm audit --audit-level=high
```

Keep changes focused, add regression coverage for behavior changes, update the
README and changelog when the public contract changes, and submit a pull request.

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](./SECURITY.md).

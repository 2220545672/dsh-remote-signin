# Development notes for agents working in this repository

`dsh-remote-signin` is a DSH plugin. Read [README.md](README.md) first: it carries the
measurements that justify the design, and the rules the code is not allowed to break.

## Layout

| Path | Purpose |
|---|---|
| `src/index.js` | The plugin: claim wrapper, asset routes, index injection. |
| `src/claim.js` | Pure origin logic, exported for tests. |
| `assets/inpage.js` | The in-page panel (client). |
| `assets/bridge.html` | The standalone page at `/remote-login` (client). |
| `cordis.patch.yml` | The loader entry a profile or `--patch` overlay picks up. |
| `test/`, `test-support/` | `node --test` suites and the DOM stub they share. |

## Rules

1. **Fail soft, never fail the boot.** DSH is the product; this plugin is a convenience.
   A missing asset, an unusable claim, an upstream rename, a duplicate route — each one
   must leave DSH running with upstream behaviour plus one log line. Nothing here may
   throw out of `apply`.
2. **Never touch upstream's validation.** The completion path is upstream's
   `/oauth/callback` route: its one-time `state` check and its PKCE verifier. This plugin
   chooses the redirect *string* and renders two ways to hand the code back; that is all.
3. **No secrets in logs or markup.** Never log `code`, `state` or tokens. The panel and
   the page take only `code` and `state` out of a pasted address, re-encode them, and send
   them to this origin's own callback — never to a URL taken from the input.
4. **Client assets stand alone.** `assets/inpage.js` and `assets/bridge.html` duplicate
   their extraction and status vocabulary on purpose: each may be the only working path
   (the panel can fail to load, the page can be reached directly). Keep both covered by
   tests rather than factoring them together.
5. **Keep the tests dependency-free.** `node --test` and `test-support/dom.mjs` only. No
   browser, no build step, no network.

## Before committing

```bash
node --test
```

Every behaviour change needs a test in `test/`, and the version in `package.json` plus
[CHANGELOG.md](CHANGELOG.md) move together when a release is tagged: the `dsh-unraid`
image pins a tag of this repository, so a pushed tag is a deployment.

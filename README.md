# dsh-remote-signin

**English** · [中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that
lets a **DeepSeek account** sign-in finish in a browser that is *not* running on the DSH
machine — the LAN, Tailscale, or anything behind a reverse proxy. Without it, that
sign-in cannot even start.

```
[entrypoint] remote sign-in: on — a remote browser finishes the sign-in in the DSH page
[remote-signin] active — v0.2.0, claim http://127.0.0.1:47821, panel at /remote-signin/inpage.js
[remote-signin] active — claim http://127.0.0.1:47821, panel at /remote-signin/inpage.js
```

## The problem, measured

Upstream hands the platform the **browser's own origin** as the OAuth `redirect_uri`, and
`@deepseek-ai/dsh-deepseek-account-platform` only accepts a loopback HTTP origin with an
explicit port. Measured 2026-10-16 against the real platform
(`POST /auth-api/v0/dsh/auth_init`):

| `redirect_uri` | platform answer |
|---|---|
| `http://127.0.0.1:47821/oauth/callback` | `{"code":0, … "authorize_url": …}`, `expires_in: 600` |
| `https://dsh.example.com/oauth/callback` | `{"code":50005,"msg":"PAYLOAD_SCHEMA_MISMATCH"}` |

So the request dies before a login page is ever opened. Your options used to be an API
key, or an `ssh -L` tunnel to a browser that can reach a loopback address.

## What the plugin does

It splits the two halves of that check: the platform validates a **string**, while the
**browser** is the only thing that has to reach the address in it.

```
1. browser (https://dsh.example.com)      you press "Sign in"
2. DSH host + this plugin                 origin is not loopback → replaced by the claim
   └─ auth_init(redirect_uri = http://127.0.0.1:47821/oauth/callback)
3. platform.deepseek.com                  accepts, returns authorize_url
4. browser                                you log in there
5. browser                                platform redirects to 127.0.0.1:47821 → dead end,
                                          but the address bar holds `code` and `state`
6. DSH page, this plugin's panel          appears by itself while the sign-in waits:
                                          paste that address → it is sent to this origin's
                                          own /oauth/callback
7. DSH host, upstream's callback route    one-time `state` check + the PKCE verifier it
                                          kept in memory → credential stored, dialog turns green
```

Two parts, both in this package:

| Piece | What it is |
|---|---|
| `src/index.js` | Server plugin: wraps `deepseekAccount.startSignIn` so a non-loopback browser origin is registered as the claimed loopback origin, serves the panel script, and injects it into the DSH document. |
| `assets/inpage.js` | The panel: appears in the DSH page while a sign-in waits, takes the pasted callback address, and reports what the server answered. It is the only way back — there is no second page to find. |

## Install

**Unraid / `dsh-unraid` image** — nothing to do; the image installs this plugin and loads
it through `REMOTE_SIGNIN` (default `on`; set `off` for upstream's behaviour).

**Any DSH profile** — install it into the profile, which picks up
`cordis.patch.yml` through the package's `dsh.bundle` declaration:

```bash
dsh plugin --profile web add github:2220545672/dsh-remote-signin
```

**Or load it as a patch overlay** (no profile change):

```bash
dsh --profile web --patch "$(node -p "require.resolve('dsh-remote-signin/cordis.patch.yml')")"
```

### One caveat about where the package lives

A patch entry's `name` is resolved from two anchors: the packages carried by the
`@deepseek-ai/dsh` **installation** (its dependency closure), and the **profile**
directory (`$DSH_HOME/profiles/<name>/node_modules`). A package installed anywhere else
— a dependency of your own runtime manifest, or a copy in an image — is in neither, and
`name: dsh-remote-signin` then fails with `ERR_MODULE_NOT_FOUND`. Two ways out, both
used in practice:

* install into the profile (`dsh plugin … add …`, above), where the name resolves; or
* point the entry at the file, as the `dsh-unraid` image does:

  ```yaml
  - insert:
      - id: remote-signin
        name: file:///app/node_modules/dsh-remote-signin/src/index.js
  ```

The claim is the only setting, and it has a sane default:

| Source | Meaning |
|---|---|
| `config.claimOrigin` in the patch entry | Highest priority. |
| `REMOTE_SIGNIN_ORIGIN` | Environment fallback. Must be `http://` + `127.0.0.1` / `localhost` / `[::1]` + an explicit port. |
| default | `http://127.0.0.1:47821`. |

## What it deliberately does not do

* **It does not relax any validation.** The callback that completes the sign-in is
  upstream's route, with upstream's one-time `state` check and the PKCE verifier it keeps
  in memory. This plugin only chooses which loopback *string* is registered.
* **It does not touch a browser that is already on loopback** (`ssh -L`, the desktop app):
  those origins pass through unchanged.
* **It does not invent a look.** The panel is styled from the harness's own design
  tokens (`--dsw-*`: surface, radius, elevation, label and state colours, primary button
  fill), so it follows the app's theme — including a user-chosen dark mode — and any
  future restyle, and a test fails if a hard-coded colour creeps back in.
* **It does not store or log the code, the state or the token.** The only line it writes
  is the origin it claimed for, once per attempt. The pasted address is parsed in the
  browser; only `code` and `state` are re-encoded and sent — to this origin's own
  `/oauth/callback`, never anywhere else, so the panel cannot be used as a redirector.
* **It does not open a port.** The claim is a string; nothing listens on it, on the server
  or on your machine. The port is deliberately an odd one so a stray local service is
  never handed the code.
* **It never becomes the reason a container will not start.** A missing asset, an
  unusable claim, or a future upstream rename leaves DSH running with upstream behaviour
  and one line in the log.

## Troubleshooting

| Symptom | What it means |
|---|---|
| The panel never appears | The plugin is not loaded: `docker logs <container> \| grep remote-signin` says why (`off`, a missing package, `INACTIVE`). There is no fallback page — remove the cause and reload. |
| The login tab shows a DeepSeek error instead of a login form | Same cause — the claim was not applied, so upstream refused the origin. |
| The panel says **no sign-in is waiting** (`404`) | The attempt expired (~10 minutes), or it belonged to a **different DSH instance** — recreating the container throws it away, and a tab left open from the previous instance still *looks* like it is waiting. Press **Sign in** again in the tab you are actually using. |
| The panel says the state does not match (`400`) | The address came from a different attempt, or the code was already consumed. |
| `/remote-signin/inpage.js` answers 404 | That route is registered by this plugin; if it failed to load, the panel can never appear. See the log line above. |
| You want the old behaviour | Remove the plugin (or set `REMOTE_SIGNIN=off` on the dsh-unraid image). |

## Development

```bash
node --test        # 15 tests, no dependencies, no browser
```

* `src/claim.js` is pure so the claim rules can be tested without booting DSH.
* `test-support/dom.mjs` is a small DOM stub, enough to run the panel under
  `node --test`: its probe cadence, its dismissal, its extraction rules and every status
  it reports.
* Upstream is in developer preview. The plugin only depends on two contracts —
  `deepseekAccount.startSignIn` and the web server's route/index APIs — and fails soft
  when either changes.

MIT licensed. See [CHANGELOG.md](CHANGELOG.md).

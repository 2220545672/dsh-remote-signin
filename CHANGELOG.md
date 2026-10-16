# Changelog

Versions are what the `dsh-unraid` image pins, so a tag here is a deployment there.

## 0.2.0 — 2026-10-16

* **The standalone page at `/remote-login` is gone.** The panel that the DSH document
  injects is the one way back: it appears by itself while a sign-in waits, and a second
  page asked the operator to know a URL the feature exists to make unnecessary. The
  plugin now serves exactly one path (`/remote-signin/inpage.js`) and the panel no longer
  links to a page that is not there.

## 0.1.0 — 2026-10-16

First release, extracted from the `dsh-unraid` image so it can be maintained on its own.

* Claims a loopback `redirect_uri` (`http://127.0.0.1:47821` by default) so the DeepSeek
  platform accepts an `auth_init` from a remote browser.
* Injects a panel into the DSH page that appears by itself while a sign-in waits, takes
  the pasted `127.0.0.1` callback address, and reports the server's answer in place.
* Serves the same thing as a standalone page at `/remote-login`.
* Fails soft: an unusable claim, a missing asset or an upstream rename leaves DSH running
  with upstream behaviour and one log line.

## 0.1.1 — 2026-10-16

* The activation line names the loaded version (`[remote-signin] active — v0.1.1, …`), so a
  support log says which build an image carries without inspecting it.

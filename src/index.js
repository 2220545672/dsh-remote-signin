/**
 * dsh-remote-signin — finish a DeepSeek account sign-in from a browser that is not
 * running on the DSH machine.
 *
 * The plugin is one of three parts; this file is the server half.
 *
 *   src/index.js        this file: claims the loopback redirect, serves the assets,
 *                       and injects the panel into the DSH page.
 *   assets/inpage.js    the panel itself: appears while a sign-in waits, takes the
 *                       pasted callback address, and reports what the server answered.
 *   assets/bridge.html  the same thing as a standalone page at /remote-login, for
 *                       when the panel did not appear (or is not wanted).
 *
 * Why any of it is needed: upstream only accepts a loopback `redirect_uri`, so the
 * platform's answer is delivered to an address on the *operator's* machine, where
 * nothing listens. The claim passes that check; the code comes back out of band.
 *
 * Nothing about the flow's security is relaxed. The callback that completes it is
 * upstream's own route with upstream's one-time `state` check and the PKCE verifier it
 * keeps in memory; this plugin only chooses which loopback string is registered, and
 * adds the two ways to hand the code back.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_CLAIM_ORIGIN, mapCallbackOrigin, normalizeClaimOrigin } from "./claim.js";

export const name = "remote-signin";
/** Upstream service the claim wraps; the plugin stays inactive without it. */
export const inject = ["deepseekAccount"];

export { DEFAULT_CLAIM_ORIGIN, isLoopbackCallbackOrigin, mapCallbackOrigin, normalizeClaimOrigin } from "./claim.js";

/** Marks the wrapper so the startup check can find it through a tracing accessor. */
const WRAPPER = Symbol.for("dsh.remote-signin.wrapper");

/** Paths this plugin owns. Kept out of `/remote-login` so a Caddy route can coexist. */
export const BRIDGE_PATH = "/remote-login";
export const BRIDGE_PATH_SLASH = "/remote-login/";
export const PANEL_PATH = "/remote-signin/inpage.js";

/** This package's version, read once so a support log says which build is loaded. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const JS_HEADERS = {
  "content-type": "application/javascript; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * Read one packaged asset.
 * @param file - asset file name.
 * @returns its text, or null (with one error line) when it cannot be read.
 */
function readAsset(file) {
  try {
    return readFileSync(new URL(`../assets/${file}`, import.meta.url), "utf8");
  } catch (error) {
    console.error(`[remote-signin] cannot read assets/${file}: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * Answer one request with a fixed body.
 * @param body - response body.
 * @param headers - response headers.
 * @returns a webServer route handler.
 */
function fixedBody(body, headers) {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(Buffer.byteLength(body)) });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

/**
 * Wrap `startSignIn` on the live account service so a non-loopback browser origin is
 * replaced by the claim.
 *
 * The prototype is the patch point because that is where every resolution path ends,
 * including the per-access tracing view Cordis hands back from `ctx.deepseekAccount`.
 * Reachability through that accessor is then verified with a marker and reported once:
 * a silent no-op is the one failure an operator could not diagnose from the UI, since
 * the symptom (a remote browser failing to sign in) is what the plugin exists to cure.
 *
 * @param ctx - Cordis context carrying the account service.
 * @param claim - normalized claim origin.
 * @returns true when the wrapper is in place.
 */
function claimSignIn(ctx, claim) {
  let service;
  try {
    service = ctx.deepseekAccount;
  } catch {
    service = undefined;
  }
  if (service === undefined || typeof service.startSignIn !== "function") {
    console.error("[remote-signin] the deepseekAccount service is unavailable; remote sign-in stays off");
    return false;
  }

  const prototype = Object.getPrototypeOf(service);
  const original = typeof prototype?.startSignIn === "function" ? prototype.startSignIn : service.startSignIn;
  // Profiles reload their patches live, so this plugin can be applied again in the
  // same process. The wrapper is installed on a prototype, which is per-import and
  // therefore per-process: a second apply must not wrap the wrapper (double log lines
  // for nothing), and it must still go on to serve its assets, because the previous
  // apply's routes may already have been disposed with its plugin instance.
  if (original?.[WRAPPER] === true) {
    console.log(`[remote-signin] the account service is already claimed (${claim}); keeping the existing wrapper`);
    return true;
  }

  const wrapped = function startSignIn(client, callbackOrigin, loginSource) {
    const mapped = mapCallbackOrigin(callbackOrigin, claim);
    if (mapped !== callbackOrigin) {
      // The origin is not a secret; the code, state and tokens that follow are, and
      // none of them is ever logged here.
      console.log(`[remote-signin] claiming ${claim} for browser origin ${JSON.stringify(callbackOrigin)}`);
    }
    return original.call(this, client, mapped, loginSource);
  };
  wrapped[WRAPPER] = true;

  try {
    prototype.startSignIn = wrapped;
  } catch (error) {
    console.error(`[remote-signin] could not patch the account service: ${error?.message ?? error}`);
    return false;
  }

  // Identity comparison is deliberately NOT the check: `ctx.deepseekAccount` hands out
  // a per-access tracing view whose prototype is this one, so the honest test is that
  // the marker is reachable through the accessor the API controller uses. The first
  // "claiming" line is what proves the call really lands in the wrapper.
  let reachable = false;
  try {
    const view = ctx.deepseekAccount;
    const marker = (value) => Boolean(value) && value[WRAPPER] === true;
    reachable = marker(view?.startSignIn) || marker(Object.getPrototypeOf(view)?.startSignIn);
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.error("[remote-signin] INACTIVE — the account service does not resolve the patched startSignIn; remote sign-in stays off");
    return false;
  }
  return true;
}

/**
 * Serve the standalone page and the panel script, and inject the panel into the DSH
 * document — the panel is what makes the flow automatic: it appears on its own while a
 * sign-in waits, instead of requiring the operator to remember a URL.
 *
 * @param ctx - Cordis context.
 * @param assets - asset texts, read once at apply time.
 */
function serveAndInject(ctx, assets) {
  ctx.inject(["webServer"], (webCtx) => {
    const routes = [
      { path: BRIDGE_PATH, body: assets.bridge, headers: HTML_HEADERS },
      { path: BRIDGE_PATH_SLASH, body: assets.bridge, headers: HTML_HEADERS },
      { path: PANEL_PATH, body: assets.panel, headers: JS_HEADERS },
    ];
    for (const route of routes) {
      // Routes are a composition-level contract and a duplicate (kind, path) throws.
      // A duplicate here means another instance of this plugin is already serving that
      // path (a live profile reload can briefly have both), which is fine — but one
      // failed registration must never take the others, or the boot, down with it.
      try {
        webCtx.effect(
          () => webCtx.webServer.register({ kind: "exact", path: route.path, handler: fixedBody(route.body, route.headers) }),
          `remote-signin: ${route.path}`,
        );
      } catch (error) {
        if (/duplicate/i.test(String(error?.message ?? error))) {
          console.log(`[remote-signin] ${route.path} is already served; leaving that instance in place`);
        } else {
          console.error(`[remote-signin] could not serve ${route.path}: ${error?.message ?? error}`);
        }
      }
    }
  });

  // One row per document render; the panel is inert until a sign-in waits, so it is
  // injected unconditionally while the plugin is loaded.
  ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "script-src", src: PANEL_PATH, placement: "body" });
  });
}

/**
 * Plugin entry point.
 * @param ctx - Cordis context.
 * @param config - `{ claimOrigin }` from the patch entry, overridden by nothing else.
 */
export function apply(ctx, config = {}) {
  const configured = config?.claimOrigin ?? process.env.REMOTE_SIGNIN_ORIGIN ?? DEFAULT_CLAIM_ORIGIN;
  const claim = normalizeClaimOrigin(configured);
  if (claim === null) {
    console.error(
      `[remote-signin] ${JSON.stringify(configured)} is not a loopback http origin with an explicit port` +
        ` (expected e.g. ${DEFAULT_CLAIM_ORIGIN}); remote sign-in stays off`,
    );
    return;
  }

  // Both assets are required: without the panel and the page there would be no way to
  // bring the code back, and claiming a loopback origin would only turn a clear local
  // failure into a dead end on the operator's machine.
  const bridge = readAsset("bridge.html");
  const panel = readAsset("inpage.js");
  if (bridge === null || panel === null) {
    console.error("[remote-signin] packaged assets are incomplete; remote sign-in stays off");
    return;
  }

  if (!claimSignIn(ctx, claim)) return;
  serveAndInject(ctx, { bridge, panel });
  console.log(`[remote-signin] active — v${VERSION}, claim ${claim}, panel at ${PANEL_PATH}, page at ${BRIDGE_PATH}`);
}

export default { name, inject, apply };

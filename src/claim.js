/**
 * The loopback claim: the one piece of upstream behaviour this plugin bends.
 *
 * `@deepseek-ai/dsh-deepseek-account-platform` hands the platform the browser's own
 * origin as the OAuth `redirect_uri`, and only accepts a loopback HTTP origin with an
 * explicit port. Measured 2026-10-16 against `POST /auth-api/v0/dsh/auth_init`:
 *
 *   http://127.0.0.1:47821/oauth/callback  -> {"code":0, ... "authorize_url": ...}
 *   https://dsh.example.com/oauth/callback -> {"code":50005,"msg":"PAYLOAD_SCHEMA_MISMATCH"}
 *
 * So a browser that is not running on the DSH machine cannot start a sign-in at all.
 * The plugin replaces that origin with a claimed loopback one — a string nothing ever
 * listens on — and brings the authorization code back out of band (the panel).
 *
 * These helpers are pure so the rules can be tested without booting DSH.
 */

/** Loopback host spellings upstream's `loginOrigin()` accepts. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The claim used when neither config nor `REMOTE_SIGNIN_ORIGIN` says otherwise. */
export const DEFAULT_CLAIM_ORIGIN = "http://127.0.0.1:47821";

/**
 * Normalize a claimed loopback origin.
 *
 * The same shape upstream accepts, and nothing else: plain HTTP, one of the three
 * loopback spellings, an explicit non-zero port, no credentials, path, query or
 * fragment. Kept identical on purpose — a claim upstream would reject is worse than no
 * claim at all, because it turns a clear local error into a platform error.
 *
 * @param value - candidate origin, typically from config or `REMOTE_SIGNIN_ORIGIN`.
 * @returns the normalized `http://host:port` origin, or null when unusable.
 */
export function normalizeClaimOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
  if (!/^[0-9]{1,5}$/.test(url.port)) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return `http://${url.hostname}:${port}`;
}

/**
 * Is this origin one a browser can reach on loopback, as upstream defines it?
 * @param value - the origin the UI reported.
 * @returns true when upstream would accept it unchanged.
 */
export function isLoopbackCallbackOrigin(value) {
  return normalizeClaimOrigin(value) !== null;
}

/**
 * Decide which origin to register with the platform for one sign-in attempt.
 *
 * Pass-through is the default and the common case for an `ssh -L` tunnel or the
 * desktop app; only a genuinely remote browser is redirected to the claim.
 *
 * @param value - the callback origin reported by the UI.
 * @param claim - the normalized loopback claim from {@link normalizeClaimOrigin}.
 * @returns the origin to hand to the platform.
 */
export function mapCallbackOrigin(value, claim) {
  return isLoopbackCallbackOrigin(value) ? value : claim;
}

import assert from "node:assert/strict";
import test from "node:test";
import { PANEL_PATH, apply } from "../src/index.js";

/**
 * A Cordis context stub recording everything the plugin touches.
 *
 * The fake service class is created per context on purpose: the plugin patches the
 * *prototype*, and a prototype is per-import (i.e. per-process) in the real thing — a
 * module-level class would leak one test's wrapper into the next, which is exactly the
 * bug this harness should not have.
 */
function fakeContext() {
  class FakeAccount {
    constructor() {
      this.calls = [];
    }
    startSignIn(client, callbackOrigin, loginSource) {
      this.calls.push({ client, callbackOrigin, loginSource });
      return { ok: true };
    }
  }
  const service = new FakeAccount();
  const routes = new Map();
  const effects = [];
  const listeners = new Map();
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const webCtx = {
    webServer,
    effect(factory, label) {
      effects.push({ label, dispose: factory() });
      return () => {};
    },
  };
  const ctx = {
    deepseekAccount: service,
    inject(names, callback) {
      assert.deepEqual(names, ["webServer"]);
      callback(webCtx);
    },
    on(event, handler) {
      (listeners.get(event) ?? listeners.set(event, []).get(event)).push(handler);
    },
    emit(event, table) {
      for (const handler of listeners.get(event) ?? []) handler(table);
    },
  };
  return { ctx, service, routes, effects, listeners };
}

/** Minimal ServerResponse stand-in. */
function fakeResponse() {
  const written = { status: 0, headers: {}, body: undefined, ended: false };
  return {
    written,
    writeHead(status, headers) {
      written.status = status;
      written.headers = headers ?? {};
      return this;
    },
    end(body) {
      written.body = body;
      written.ended = true;
      return this;
    },
  };
}

test("apply claims a remote origin, leaves loopback alone, and serves the panel", () => {
  const { ctx, service, routes } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });

  // The claim: only a browser that is not already on loopback is rewritten.
  service.startSignIn({ locale: "zh-CN" }, "https://dsh.example.com", "web");
  service.startSignIn({ locale: "zh-CN" }, "http://127.0.0.1:3081", "web");
  assert.deepEqual(
    service.calls.map((call) => call.callbackOrigin),
    ["http://127.0.0.1:47821", "http://127.0.0.1:3081"],
  );

  // Exactly one path is served: the panel script the document injects.
  assert.deepEqual([...routes.keys()], [PANEL_PATH]);

  const panel = fakeResponse();
  routes.get(PANEL_PATH).handler({ method: "GET" }, panel);
  assert.equal(panel.written.status, 200);
  assert.match(panel.written.headers["content-type"], /^application\/javascript/);
  assert.equal(panel.written.headers["cache-control"], "no-store");
  assert.match(panel.written.body, /remote-signin-panel/);
  assert.match(panel.written.body, /oauth\/callback/, "the panel is the only way back, so it must carry the paste logic");

  // HEAD carries the headers but no body; anything else is refused.
  const head = fakeResponse();
  routes.get(PANEL_PATH).handler({ method: "HEAD" }, head);
  assert.equal(head.written.status, 200);
  assert.equal(head.written.body, undefined);
  const post = fakeResponse();
  routes.get(PANEL_PATH).handler({ method: "POST" }, post);
  assert.equal(post.written.status, 405);
});

test("apply injects the panel into the DSH document", () => {
  const { ctx } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  const table = [];
  ctx.emit("webserver/index-inject", table);
  assert.deepEqual(table, [{ kind: "script-src", src: PANEL_PATH, placement: "body" }]);
});

test("applying twice stays one wrapper, so a live profile reload cannot double it", () => {
  const { ctx, service } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  service.startSignIn({}, "https://dsh.example.com", "web");
  assert.deepEqual(
    service.calls.map((call) => call.callbackOrigin),
    ["http://127.0.0.1:47821"],
  );
});

test("an unusable claim leaves upstream behaviour and serves nothing", () => {
  for (const claimOrigin of ["https://127.0.0.1:47821", "http://192.168.3.2:47821", "http://127.0.0.1", "nonsense"]) {
    const { ctx, service, routes } = fakeContext();
    apply(ctx, { claimOrigin });
    assert.equal(routes.size, 0, `expected no routes for ${claimOrigin}`);
    assert.equal(
      Object.getPrototypeOf(service).startSignIn.name,
      "startSignIn",
      `expected the service to stay unpatched for ${claimOrigin}`,
    );
    service.startSignIn({}, "https://dsh.example.com", "web");
    // Unpatched means upstream would reject this — the point is that we did not touch it.
    assert.deepEqual(service.calls.map((call) => call.callbackOrigin), ["https://dsh.example.com"]);
  }
});

test("REMOTE_SIGNIN_ORIGIN is honoured and config wins over it", () => {
  const previous = process.env.REMOTE_SIGNIN_ORIGIN;
  process.env.REMOTE_SIGNIN_ORIGIN = "http://localhost:44444";
  try {
    const fromEnv = fakeContext();
    apply(fromEnv.ctx, {});
    fromEnv.service.startSignIn({}, "https://dsh.example.com", "web");
    assert.equal(fromEnv.service.calls[0].callbackOrigin, "http://localhost:44444");

    const fromConfig = fakeContext();
    apply(fromConfig.ctx, { claimOrigin: "http://127.0.0.1:47821" });
    fromConfig.service.startSignIn({}, "https://dsh.example.com", "web");
    assert.equal(fromConfig.service.calls[0].callbackOrigin, "http://127.0.0.1:47821");
  } finally {
    if (previous === undefined) delete process.env.REMOTE_SIGNIN_ORIGIN;
    else process.env.REMOTE_SIGNIN_ORIGIN = previous;
  }
});

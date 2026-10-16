/**
 * dsh-remote-signin — the in-page panel.
 *
 * Injected into the DSH document by the plugin (`webserver/index-inject`). It watches
 * for a waiting sign-in and, when there is one, offers the paste step right where the
 * operator already is: no jump to another page, no second tab, nothing to remember.
 *
 * How "a sign-in is waiting" is detected without any extra endpoint: upstream
 * registers `/oauth/callback` on the web server exactly while an attempt waits, and
 * answers 400 to a request without `code`/`state`. With no attempt the path is not
 * registered at all and the fallback seat answers 404. So the probe is free of side
 * effects and needs no API of ours.
 *
 * The extraction and the status vocabulary are intentionally duplicated in
 * assets/bridge.html (the standalone fallback): each file has to stand on its own, and
 * test/inpage.test.mjs plus test/bridge-page.test.mjs exercise both.
 */
(function () {
  "use strict";

  var CALLBACK = "/oauth/callback";
  var IDLE_MS = 3000;
  var WAITING_MS = 2000;
  var zh = /^zh/i.test((navigator && navigator.language) || "en");
  var t = function (en, cn) { return zh ? cn : en; };

  var root = null;      // the panel element
  var status = null;    // status line inside it
  var input = null;     // the paste box
  var button = null;
  var waiting = false;
  var dismissed = false;
  var succeeded = false;

  /**
   * Pull `code` and `state` out of whatever was pasted: a full URL, a bare query
   * string, or either with surrounding whitespace. Everything else is dropped, so the
   * only address this ever requests is `/oauth/callback` on this same origin.
   */
  function extract(raw) {
    var text = String(raw || "").trim();
    if (text.length === 0 || text.length > 4096) return null;
    var query = text;
    var mark = query.indexOf("?");
    if (mark !== -1) {
      var head = query.slice(0, mark);
      query = query.slice(mark + 1);
      var hash = query.indexOf("#");
      if (hash !== -1) query = query.slice(0, hash);
      if (head.indexOf("127.0.0.1") === -1 && head.indexOf("localhost") === -1 && head.indexOf("[::1]") === -1) return null;
      if (head.indexOf("/oauth/callback") === -1) return null;
    }
    var params = new URLSearchParams(query);
    var code = params.get("code");
    var state = params.get("state");
    if (!code || !state) return null;
    if (params.getAll("code").length !== 1 || params.getAll("state").length !== 1) return null;
    return { code: code, state: state };
  }

  /** Turn one HTTP status into something the operator can act on. */
  function describe(code) {
    if (code === 404) {
      return {
        kind: "error",
        text: t(
          "This server has no sign-in waiting: it expired (about 10 minutes), or it was started against a different DSH instance. Press Sign in again.",
          "这台服务器上没有正在等待的登录：已过期（约 10 分钟），或者它是在另一个 DSH 实例上发起的。重新点一次登录。",
        ),
      };
    }
    if (code === 400) {
      return {
        kind: "error",
        text: t(
          "That address is not the callback of a waiting sign-in: its state does not match, it is truncated, or it was already used.",
          "这个地址不是某个等待中登录的回调地址：state 不匹配、地址被截断，或者已经用过了。",
        ),
      };
    }
    if (code === 410) {
      return {
        kind: "error",
        text: t("That code was already delivered once.", "这个 code 已经提交过一次了。"),
      };
    }
    if (code === 401 || code === 403) {
      return {
        kind: "error",
        text: t("This browser is not signed in to DSH.", "这个浏览器还没有 DSH 的会话。"),
      };
    }
    return {
      kind: "error",
      text: t(
        "The server answered HTTP " + code + ". See the container log: docker logs <container> | grep remote-signin",
        "服务器返回 HTTP " + code + "。看容器日志：docker logs <容器名> | grep remote-signin",
      ),
    };
  }

  function setStatus(text, kind) {
    if (status === null) return;
    status.textContent = text;
    status.dataset.kind = kind || "";
  }

  /** Build the panel once; later calls only toggle it. */
  function build() {
    var style = document.createElement("style");
    style.textContent = [
      "#dsh-remote-signin-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:min(24rem,calc(100vw - 32px));",
      "box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;border:1px solid var(--rs-line);",
      "background:var(--rs-bg);color:var(--rs-fg);box-shadow:0 8px 30px rgba(0,0,0,.18);",
      "font:13px/1.55 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"PingFang SC\",\"Microsoft YaHei\",sans-serif}",
      "#dsh-remote-signin-panel h2{margin:0 0 6px;font-size:14px;font-weight:600}",
      "#dsh-remote-signin-panel p{margin:0 0 8px;color:var(--rs-muted)}",
      "#dsh-remote-signin-panel textarea{width:100%;box-sizing:border-box;min-height:3.4rem;margin:0 0 8px;padding:6px 8px;",
      "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:inherit;background:transparent;",
      "border:1px solid var(--rs-line);border-radius:8px;resize:vertical}",
      "#dsh-remote-signin-panel .rs-actions{display:flex;gap:8px;align-items:center}",
      "#dsh-remote-signin-panel button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;",
      "background:var(--rs-accent);color:#fff}",
      "#dsh-remote-signin-panel button[disabled]{opacity:.5;cursor:default}",
      "#dsh-remote-signin-panel .rs-close{margin-left:auto;background:transparent;color:var(--rs-muted);font-weight:400;padding:4px 6px}",
      "#dsh-remote-signin-panel a{color:var(--rs-accent);font-size:12px}",
      "#dsh-remote-signin-panel .rs-status{margin-top:8px;min-height:1.3em}",
      "#dsh-remote-signin-panel .rs-status[data-kind=error]{color:var(--rs-err)}",
      "#dsh-remote-signin-panel .rs-status[data-kind=ok]{color:var(--rs-ok)}",
      "#dsh-remote-signin-panel{--rs-fg:#1b1c1e;--rs-muted:#5c6169;--rs-line:#d9dbe0;--rs-bg:#fff;--rs-accent:#4d6bfe;--rs-err:#c0392b;--rs-ok:#1e874b}",
      "@media (prefers-color-scheme:dark){#dsh-remote-signin-panel{--rs-fg:#e8e9ec;--rs-muted:#a2a7b0;--rs-line:#3a3d43;--rs-bg:#1b1d22;--rs-accent:#8ea2ff;--rs-err:#ff8b7d;--rs-ok:#5ddc9a}}",
    ].join("");
    document.head.appendChild(style);

    root = document.createElement("section");
    root.id = "dsh-remote-signin-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", t("Finish the DeepSeek sign-in", "完成 DeepSeek 账号登录"));

    var title = document.createElement("h2");
    title.textContent = t("Finish the DeepSeek sign-in", "完成 DeepSeek 账号登录");

    var hint = document.createElement("p");
    hint.textContent = t(
      "The login tab ends on a dead 127.0.0.1 page. Copy its address and paste it here (within ~10 minutes).",
      "登录标签页会停在一个打不开的 127.0.0.1 页面上。把它地址栏里的地址复制到这里粘贴（约 10 分钟内有效）。",
    );

    input = document.createElement("textarea");
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "http://127.0.0.1:47821/oauth/callback?code=…&state=…";

    var actions = document.createElement("div");
    actions.className = "rs-actions";
    button = document.createElement("button");
    button.type = "button";
    button.textContent = t("Finish sign-in", "完成登录");

    var link = document.createElement("a");
    link.href = "/remote-login";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t("standalone page", "独立页面");

    var close = document.createElement("button");
    close.type = "button";
    close.className = "rs-close";
    close.title = t("Hide until the next sign-in", "隐藏（下次登录再出现）");
    close.textContent = "✕";
    close.addEventListener("click", function () {
      dismissed = true;
      hide();
    });

    status = document.createElement("div");
    status.className = "rs-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    actions.appendChild(button);
    actions.appendChild(link);
    actions.appendChild(close);
    root.appendChild(title);
    root.appendChild(hint);
    root.appendChild(input);
    root.appendChild(actions);
    root.appendChild(status);
    document.body.appendChild(root);

    button.addEventListener("click", submit);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });
  }

  function show() {
    if (root === null) build();
    root.style.display = "";
  }

  function hide() {
    if (root !== null) root.style.display = "none";
  }

  /** Send the pasted code to upstream's own callback on this origin, and read the answer. */
  function submit() {
    var pairs = extract(input.value);
    if (pairs === null) {
      setStatus(
        t(
          "That does not look like the callback address of this sign-in (it must contain code= and state=).",
          "这个地址看起来不是本次登录的回调地址（必须包含 code= 与 state=）。",
        ),
        "error",
      );
      return;
    }
    button.disabled = true;
    setStatus(t("Finishing the sign-in…", "正在完成登录…"), "ok");
    var target = new URLSearchParams();
    target.set("code", pairs.code);
    target.set("state", pairs.state);
    // Same origin, upstream's own callback path: the one-time `state` authorises it.
    // Fetched rather than navigated to, so the answer can be read and explained.
    fetch(CALLBACK + "?" + target.toString(), {
      credentials: "same-origin",
      redirect: "manual",
      headers: { accept: "text/html" },
    })
      .then(function (response) {
        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          succeeded = true;
          setStatus(t("Signed in — you can close this.", "登录完成——可以关掉了。"), "ok");
          setTimeout(hide, 6000);
          return;
        }
        if (response.status >= 200 && response.status < 300) {
          setStatus(
            t(
              "The server took the code (HTTP " + response.status + "). Check the DSH tab: if it still says waiting, that attempt had already ended.",
              "服务器已接收授权码（HTTP " + response.status + "）。请看 DSH：若仍停在“等待登录”，说明那次尝试已经结束。",
            ),
            "ok",
          );
          button.disabled = false;
          return;
        }
        var described = describe(response.status);
        setStatus(described.text, described.kind);
        button.disabled = false;
      })
      .catch(function () {
        setStatus(t("The request did not reach DSH.", "请求没有到达 DSH。"), "error");
        button.disabled = false;
      });
  }

  /**
   * One probe: 400 means an attempt is waiting (upstream's callback route exists and
   * rejected a request without code/state); 404 means it does not exist at all.
   */
  function probe() {
    if (document.visibilityState === "hidden") {
      schedule(IDLE_MS);
      return;
    }
    fetch(CALLBACK, { method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store" })
      .then(function (response) {
        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          // Something just completed (another tab, or the standalone page).
          if (!succeeded) {
            succeeded = true;
            show();
            setStatus(t("Signed in — you can close this.", "登录完成——可以关掉了。"), "ok");
            setTimeout(hide, 8000);
          }
          return;
        }
        if (response.status === 400) {
          if (!waiting) {
            waiting = true;
            dismissed = false;
            succeeded = false;
            if (input !== null) input.value = "";
          }
          if (!dismissed) show();
          return;
        }
        // 404 and anything else: no attempt is waiting.
        if (waiting) {
          waiting = false;
          dismissed = false;
        }
        hide();
      })
      .catch(function () {
        hide();
      })
      .then(function () {
        schedule(waiting ? WAITING_MS : IDLE_MS);
      });
  }

  var timer = null;
  function schedule(ms) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(probe, ms);
  }

  function start() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", start, { once: true });
      return;
    }
    try {
      probe();
    } catch (error) {
      // The panel is a convenience; a failure here must never disturb the page.
      if (globalThis.console) console.debug("[remote-signin] panel disabled:", error);
    }
  }

  start();
})();

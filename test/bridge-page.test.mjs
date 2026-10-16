import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDom, settle } from "../test-support/dom.mjs";

/** The page is HTML with one inline script; run exactly that script. */
const HTML = readFileSync(new URL("../assets/bridge.html", import.meta.url), "utf8");
const SCRIPT = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).pop();

const DOCUMENT_IDS = ["input", "go", "status", "probe-en", "probe-zh"];

async function boot(answers, { lang = "zh" } = {}) {
  const queue = [...answers];
  const dom = createDom({ lang, documentIds: DOCUMENT_IDS, fetch: () => queue.shift() ?? { status: 404, type: "basic" } });
  dom.run(SCRIPT);
  await settle();
  await settle();
  return dom;
}

const status = (dom) => dom.document.getElementById("status");
const input = (dom) => dom.document.getElementById("input");

test("the page tells the operator up front whether anything is waiting", async () => {
  const waiting = await boot([{ status: 400, type: "basic" }]);
  assert.match(waiting.document.getElementById("probe-zh").textContent, /有登录正在等待/);
  assert.match(waiting.document.getElementById("probe-en").textContent, /A sign-in is waiting/);

  const idle = await boot([{ status: 404, type: "basic" }]);
  assert.match(idle.document.getElementById("probe-zh").textContent, /现在没有等待中的登录/);
  assert.match(idle.document.getElementById("probe-en").textContent, /No sign-in is waiting/);
});

test("the page sends the pasted address to its own origin and reports the answer", async () => {
  const good = "http://127.0.0.1:47821/oauth/callback?code=abc&state=def";
  const cases = [
    [{ status: 0, type: "opaqueredirect" }, "登录完成", "ok"],
    [{ status: 204, type: "basic" }, "已接收授权码", "ok"],
    [{ status: 404, type: "basic" }, "没有正在等待的登录", "error"],
    [{ status: 400, type: "basic" }, "state 不匹配", "error"],
    [{ status: 410, type: "basic" }, "已经提交过", "error"],
    [{ status: 401, type: "basic" }, "还没有 DSH 的会话", "error"],
    [{ status: 500, type: "basic" }, "HTTP 500", "error"],
    [new Error("network down"), "没有到达 DSH", "error"],
  ];
  for (const [answer, needle, kind] of cases) {
    const dom = await boot([{ status: 400, type: "basic" }, answer]);
    input(dom).value = good;
    dom.document.getElementById("go").click();
    await settle();
    await settle();
    assert.match(status(dom).textContent, new RegExp(needle), `expected ${needle} for ${JSON.stringify(answer)}`);
    assert.equal(status(dom).className, kind);
    assert.match(dom.calls[1].url, /^\/oauth\/callback\?code=abc&state=def$/, "only code and state are forwarded");
    assert.equal(new URL(dom.calls[1].url, "https://dsh.example.com").origin, "https://dsh.example.com");
  }
});

test("the page refuses anything that is not a loopback callback address", async () => {
  const dom = await boot([{ status: 400, type: "basic" }]);
  const refused = [
    "",
    "https://evil.example/oauth/callback?code=a&state=b",
    "http://192.168.3.2:47821/oauth/callback?code=a&state=b",
    "http://127.0.0.1:47821/oauth/callback?state=b",
    "code=a&code=b&state=c",
    `http://127.0.0.1:47821/oauth/callback?code=${"a".repeat(5000)}&state=b`,
  ];
  for (const value of refused) {
    input(dom).value = value;
    dom.document.getElementById("go").click();
    await settle();
    assert.match(status(dom).textContent, /不是本次登录的回调地址/, `expected a refusal for ${JSON.stringify(value.slice(0, 40))}`);
  }
  assert.equal(dom.calls.length, 1, "nothing but the probe may have been fetched");
});

test("the page accepts a bare query string, as long as it carries code and state", async () => {
  const dom = await boot([{ status: 400, type: "basic" }, { status: 0, type: "opaqueredirect" }]);
  input(dom).value = "  code=abc&state=def  ";
  dom.document.getElementById("go").click();
  await settle();
  await settle();
  assert.match(dom.calls[1].url, /^\/oauth\/callback\?code=abc&state=def$/);
  assert.match(status(dom).textContent, /登录完成/);
});

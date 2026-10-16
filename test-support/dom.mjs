/**
 * A deliberately small DOM stub, enough to run the two client assets under `node --test`.
 *
 * The alternative — a real browser — would prove the same logic while making this
 * repository depend on a browser toolchain. Everything the assets touch is here:
 * element creation, attributes, text, inline style, event listeners, `document.body`
 * and `document.visibilityState`, plus a fetch queue the test fills in.
 */

/** Create one element stub. */
function element(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    style: {},
    listeners: {},
    textContent: "",
    value: "",
    disabled: false,
    spellcheck: true,
    autocomplete: "",
    placeholder: "",
    type: "",
    href: "",
    target: "",
    rel: "",
    title: "",
    id: "",
    className: "",
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of this.listeners[type] ?? []) handler({ preventDefault() {}, key: "", shiftKey: false, ...event });
    },
    click() {
      this.dispatch("click");
    },
    /** Depth-first search by id, used instead of a real `getElementById`. */
    findById(wanted) {
      if (this.id === wanted) return this;
      for (const child of this.children) {
        const hit = child.findById?.(wanted);
        if (hit) return hit;
      }
      return null;
    },
  };
  return node;
}

/**
 * Install the stub globals for one script run.
 *
 * @param options - `lang`, `fetch` implementation, and ids that the *document* already
 *   contains (the standalone page's markup lives in HTML, not in the script).
 * @returns the stub document, the recorded fetch calls, and a helper that runs a script
 *   against these globals exactly once.
 */
export function createDom({ lang = "en", fetch: fetchImpl = async () => ({ status: 404, type: "basic" }), documentIds = [] } = {}) {
  const document = {
    head: element("head"),
    body: element("body"),
    visibilityState: "visible",
    documentElement: { dataset: { lang } },
    createElement: (tag) => element(tag),
    addEventListener() {},
    getElementById(wanted) {
      const hit = this.head.findById(wanted) ?? this.body.findById(wanted);
      if (hit) return hit;
      if (documentIds.includes(wanted)) {
        const created = element("div");
        created.id = wanted;
        this.body.appendChild(created);
        return created;
      }
      return null;
    },
  };

  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(fetchImpl(String(url), init ?? {})).then((result) => {
      if (result instanceof Error) throw result;
      return result;
    });
  };

  // Timers are recorded instead of scheduled: the assets poll on a timer, and a test
  // should drive that deterministically instead of waiting three real seconds.
  const timers = [];
  const setTimeoutStub = (fn, ms) => {
    const timer = { fn, ms };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutStub = (timer) => {
    const at = timers.indexOf(timer);
    if (at !== -1) timers.splice(at, 1);
  };
  /** Run every pending timer callback once (in registration order). */
  const flushTimers = async () => {
    const pending = timers.splice(0, timers.length);
    for (const timer of pending) timer.fn();
    await settle();
  };

  const run = (source) => {
    const factory = new Function(
      "document",
      "navigator",
      "fetch",
      "URLSearchParams",
      "setTimeout",
      "clearTimeout",
      "globalThis",
      source,
    );
    factory(document, { language: lang }, fetch, URLSearchParams, setTimeoutStub, clearTimeoutStub, globalThis);
  };

  return { document, calls, run, element, timers, flushTimers };
}

/** Flush the microtask queue so promise chains settle. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

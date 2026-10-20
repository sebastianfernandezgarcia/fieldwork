import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function workspace({ deferSearch = false } = {}) {
  const nodes = new Map();
  const timers = new Map();
  const calls = [];
  let timerId = 0;
  let activeSearches = 0;
  let document;
  function createNode(selector) {
    let markup = "";
    const listeners = new Map();
    const node = {
      value: "",
      hidden: false,
      disabled: false,
      textContent: "",
      dataset: {},
      attributes: {},
      results: [],
      classList: { toggle() {}, contains() { return false; } },
      get innerHTML() { return markup; },
      set innerHTML(value) {
        markup = value;
        if (selector === "#reference-fields") {
          for (const match of value.matchAll(/id="reference-(\d+)"[^>]*value="([^"]*)"/g)) {
            const input = createNode(`#reference-${match[1]}`);
            input.value = match[2];
            input.dataset.referenceIndex = match[1];
            nodes.set(`#reference-${match[1]}`, input);
            const results = createNode(`#search-${match[1]}`);
            results.hidden = true;
            nodes.set(`#search-${match[1]}`, results);
          }
        } else if (selector.startsWith("#search-")) {
          node.results = [...value.matchAll(/data-result="(\d+)"/g)].map((match) => {
            const button = createNode(`${selector}:result-${match[1]}`);
            button.dataset.result = match[1];
            return button;
          });
        }
      },
      addEventListener(type, handler) {
        const handlers = listeners.get(type) || [];
        handlers.push(handler);
        listeners.set(type, handlers);
      },
      async dispatch(type) {
        for (const handler of listeners.get(type) || []) {
          await handler({ preventDefault() {} });
        }
      },
      setAttribute(name, value) { node.attributes[name] = value; },
      querySelector: (query) => query === "button" ? node.results[0] : element(query),
      querySelectorAll(query) {
        if (query === "[data-result]") return node.results;
        if (query === "input,select,textarea,button") return [...nodes.values()];
        return [];
      },
      focus() {
        if (document.activeElement === node) return;
        document.activeElement?.dispatch("blur");
        document.activeElement = node;
      },
    };
    return node;
  }
  function element(selector) {
    if (!nodes.has(selector)) nodes.set(selector, createNode(selector));
    return nodes.get(selector);
  }
  document = {
    activeElement: null,
    querySelector: element,
    querySelectorAll(selector) {
      return selector === "[data-reference-index]"
        ? [...nodes.entries()].filter(([key]) => /^#reference-\d+$/.test(key)).map(([, node]) => node)
        : [];
    },
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    structuredClone,
    AbortController,
    localStorage: { setItem() {} },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetch: (path, options) => {
      const call = { path, signal: options.signal, activeSearchesAtDispatch: activeSearches };
      calls.push(call);
      if (path === "/api/rehearse") {
        const body = JSON.parse(options.body);
        return Promise.resolve({
          ok: true,
          json: async () => ({
            runId: "simulated-study",
            revision: 1,
            brief: body.brief,
            dataMode: body.dataMode,
            treatments: [],
            candidates: [],
            locks: [],
            provenance: { qlooUsed: false },
          }),
        });
      }
      if (path === "/api/revise") {
        const body = JSON.parse(options.body);
        const previous = JSON.parse(run("JSON.stringify(app.run)"));
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ...previous,
            revision: previous.revision + 1,
            brief: {
              ...previous.brief,
              ...body.briefEdits,
              ...(body.action.type === "change-city" ? { city: body.action.city } : {}),
            },
          }),
        });
      }
      assert.ok(path.startsWith("/api/search?"), `Unexpected simulated request: ${path}`);
      activeSearches += 1;
      return new Promise((resolve, reject) => {
        let serverCompleted = false;
        let clientAborted = false;
        call.complete = (failure = false) => {
          if (serverCompleted) return;
          serverCompleted = true;
          activeSearches -= 1;
          if (clientAborted) return;
          if (failure) return reject(new Error("Simulated search failure"));
          resolve({
            ok: true,
            json: async () => ({
              candidates: [{ id: "sample:amelie", name: "Amélie", domain: "movie", source: "fixture" }],
            }),
          });
        };
        options.signal?.addEventListener("abort", () => {
          if (serverCompleted || clientAborted) return;
          clientAborted = true;
          // The client promise rejects, but the provider lease remains occupied.
          reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
        });
        if (!deferSearch) call.complete();
      });
    },
  });
  const run = (code) => vm.runInContext(code, context);
  run(source.replace(/\ninit\(\);\s*$/, "\n"));
  run("setBrief(defaults)");
  return {
    run,
    calls,
    element,
    document,
    activeSearches: () => activeSearches,
    async type(index, text) {
      const input = element(`#reference-${index}`);
      input.focus();
      input.value = text;
      await input.dispatch("input");
      return input;
    },
    fireSearchTimers() {
      const pending = [];
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 280) continue;
        timers.delete(id);
        pending.push(timer.callback());
      }
      return pending;
    },
  };
}

test("rapid edits followed by focus outside the references send no obsolete searches before scouting", async () => {
  const w = workspace();
  await w.type(0, "Amélie");
  await w.type(1, "Rosalía");
  await w.type(2, "Camper");
  w.element("#outside-anchor").focus();
  await Promise.all(w.fireSearchTimers());
  assert.equal(w.calls.length, 0);
  await w.run("generate()");
  assert.deepEqual(w.calls.map((call) => call.path), ["/api/rehearse"]);
  assert.equal(w.calls[0].activeSearchesAtDispatch, 0);
  assert.equal(w.run("app.run.brief.references[0].query"), "Amélie");
});

for (const condition of ["lost focus", "busy workspace"]) {
  test(`a queued debounce checks ${condition} before any search transport`, async () => {
    const w = workspace();
    await w.type(0, "Amélie");
    // Bypass blur/cancellation to exercise the dispatch-time guard itself.
    if (condition === "lost focus") w.document.activeElement = w.element("#outside-anchor");
    else w.run("app.busy = true");
    await Promise.all(w.fireSearchTimers());
    assert.equal(w.calls.length, 0);
  });
}

test("blur invalidates the UI while keeping an in-flight request observable until completion", async () => {
  const w = workspace({ deferSearch: true });
  await w.type(0, "Amélie");
  const pending = w.fireSearchTimers();
  assert.equal(w.activeSearches(), 1);
  w.element("#outside-anchor").focus();
  assert.equal(w.activeSearches(), 1);
  assert.equal(w.calls[0].signal?.aborted, undefined);
  w.calls[0].complete();
  await Promise.all(pending);
  assert.equal(w.activeSearches(), 0);
  await w.run("generate()");
  assert.equal(w.calls[1].path, "/api/rehearse");
  assert.equal(w.calls[1].activeSearchesAtDispatch, 0);
});

test("scouting cancels pending debounces and waits for active requests even without a blur event", async () => {
  const w = workspace({ deferSearch: true });
  await w.type(0, "Amélie");
  const pending = w.fireSearchTimers();
  const second = w.element("#reference-1");
  second.value = "Rosalía";
  await second.dispatch("input");
  const scout = w.run("generate()");
  assert.equal(w.calls.length, 1);
  assert.equal(w.run("app.busy"), true);
  w.calls[0].complete();
  await scout;
  await Promise.all(pending);
  await Promise.all(w.fireSearchTimers());
  assert.equal(w.calls[0].signal?.aborted, undefined);
  assert.equal(w.calls[1].path, "/api/rehearse");
  assert.equal(w.calls[1].activeSearchesAtDispatch, 0);
  assert.equal(w.calls.length, 2);
});

test("a result remains selectable through the input blur that precedes its click", async () => {
  const w = workspace();
  await w.type(0, "Amelie");
  await Promise.all(w.fireSearchTimers());
  const results = w.element("#search-0");
  const button = results.results[0];
  assert.equal(results.hidden, false);
  button.focus();
  assert.equal(results.hidden, false, "Blur must not remove a result before its click");
  await button.dispatch("click");
  assert.equal(w.run("app.references[0].entityId"), "sample:amelie");
  assert.equal(w.element("#reference-0").value, "Amélie");
  assert.equal(w.document.activeElement, w.element("#reference-0"));
  assert.equal(w.calls.length, 1);
});

test("an invalidated response that arrives after refocusing cannot repopulate stale results", async () => {
  const w = workspace({ deferSearch: true });
  const input = await w.type(0, "Amélie");
  const pending = w.fireSearchTimers();
  w.element("#outside-anchor").focus();
  input.focus();
  w.calls[0].complete();
  await Promise.all(pending);
  assert.equal(w.calls[0].signal?.aborted, undefined);
  assert.equal(w.element("#search-0").hidden, true);
  assert.equal(w.element("#search-0").results.length, 0);
});

for (const operation of ["scout", "revise"]) {
  test(`${operation} waits for both server-held search slots before dispatching its request`, async () => {
    const w = workspace({ deferSearch: true });
    if (operation === "revise") {
      w.run(`
        app.run = {runId: "existing-study", revision: 1, brief: readBrief(),
          dataMode: "fixture", treatments: [], candidates: [], locks: [], provenance: {}};
        app.sessionStatus = "active";
      `);
    }
    await w.type(0, "Amélie");
    const first = w.fireSearchTimers();
    await w.type(1, "Rosalía");
    const second = w.fireSearchTimers();
    assert.equal(w.activeSearches(), 2);
    w.element("#outside-anchor").focus();

    const result = w.run(operation === "scout"
      ? "generate()"
      : 'revise({type: "change-city", city: "Lisbon"})');
    assert.equal(w.run("app.busy"), true);
    assert.equal(w.calls.length, 2, "Both server slots are still held");
    w.calls[0].complete();
    await Promise.all(first);
    assert.equal(w.activeSearches(), 1);
    assert.equal(w.calls.length, 2, "One completed search is not enough");
    w.calls[1].complete();
    await Promise.all(second);
    await result;

    assert.equal(w.calls.length, 3);
    assert.equal(w.calls[2].path, operation === "scout" ? "/api/rehearse" : "/api/revise");
    assert.equal(w.calls[2].activeSearchesAtDispatch, 0);
    assert.equal(w.run("app.busy"), false);
    assert.equal(w.run("activeReferenceSearches.size"), 0);
  });
}

test("a failed stale search releases the wait without being retried", async () => {
  const w = workspace({ deferSearch: true });
  await w.type(0, "Amélie");
  const pending = w.fireSearchTimers();
  const scout = w.run("generate()");
  assert.equal(w.calls.length, 1);
  w.calls[0].complete(true);
  await Promise.all(pending);
  await scout;
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[1].path, "/api/rehearse");
  assert.equal(w.calls[1].activeSearchesAtDispatch, 0);
  assert.equal(w.element("#search-0").hidden, true);
});

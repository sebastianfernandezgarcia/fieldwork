import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

// Run the real event handlers against a small DOM and an in-memory transport.
// No server, browser, Qloo connection or other network access is used.
function workspace(mode = "live") {
  const nodes = new Map();
  const calls = [];
  const downloads = [];
  const blobs = new Map();
  let stored = null;
  let canonical;
  function element(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const listeners = new Map();
    const node = {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      disabled: false,
      open: false,
      dataset: {},
      isConnected: true,
      classList: { toggle() {}, contains() { return false; } },
      addEventListener(type, handler) {
        const handlers = listeners.get(type) || [];
        handlers.push(handler);
        listeners.set(type, handlers);
      },
      async dispatch(type, event = {}) {
        for (const handler of listeners.get(type) || []) {
          await handler({ preventDefault() {}, ...event });
        }
      },
      setAttribute() {},
      querySelector: element,
      querySelectorAll(selector) {
        return selector === "input,select,textarea,button"
          ? [...nodes.values()]
          : [];
      },
      focus() {},
      showModal() { this.open = true; },
      close() { this.open = false; },
      click() {
        if (this.download) {
          downloads.push({ name: this.download, blob: blobs.get(this.href) });
        }
      },
    };
    nodes.set(selector, node);
    return node;
  }
  function study(dataMode, brief, runId = "new-study") {
    const candidate = {
      id: `${dataMode}:place`,
      name: dataMode === "live" ? "Provider place" : "Fictional place",
      city: brief.city,
      kind: "gallery",
      source: dataMode === "live" ? "qloo" : "fixture",
    };
    return {
      schemaVersion: "fieldwork.run.v1",
      runId,
      revision: 1,
      status: "ready",
      dataMode,
      brief: structuredClone(brief),
      provenance: { qlooUsed: dataMode === "live" },
      treatments: [{
        id: `${runId}:a`,
        title: "Quiet light",
        candidateId: candidate.id,
        candidate,
        locked: false,
        editorial: {
          source: "authored",
          premise: "A creative interpretation to test on a scout.",
          shots: [{ label: "Opening", note: "A proposed composition." }],
        },
      }],
      candidates: [candidate],
      locks: [],
      decisions: [],
      resolvedReferences: [],
      warnings: [],
    };
  }
  const context = vm.createContext({
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      createElement: (tag) => element(`created-${tag}-${downloads.length}`),
      addEventListener() {},
      activeElement: null,
    },
    localStorage: {
      getItem: () => stored,
      setItem: (_, value) => { stored = value; },
      removeItem: () => { stored = null; },
    },
    structuredClone,
    CSS: { escape: String },
    AbortController,
    Blob,
    URL: {
      createObjectURL(blob) {
        const id = `blob:${blobs.size}`;
        blobs.set(id, blob);
        return id;
      },
      revokeObjectURL() {},
    },
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ path, body });
      if (path === "/api/rehearse") {
        canonical = study(body.dataMode, body.brief);
      } else if (path === "/api/revise") {
        assert.equal(body.state.runId, canonical.runId);
        canonical.revision += 1;
        canonical.brief = { ...canonical.brief, ...body.briefEdits };
        if (body.action.type === "change-city") {
          canonical.brief.city = body.action.city;
        } else if (body.action.type === "change-reference") {
          canonical.brief.references[body.action.referenceIndex] = body.action.reference;
        } else if (["lock", "unlock"].includes(body.action.type)) {
          canonical.treatments[0].locked = body.action.type === "lock";
        }
        canonical.locks = canonical.treatments[0].locked
          ? [canonical.treatments[0].id]
          : [];
      } else if (path !== `/api/briefs/${canonical.runId}/export`) {
        throw new Error(`Unexpected transport call: ${path}`);
      }
      return { ok: true, json: async () => structuredClone(canonical) };
    },
  });
  const run = (code) => vm.runInContext(code, context);
  run(source.replace(/\ninit\(\);\s*$/, "\n"));
  run("setBrief(defaults)");
  canonical = study(mode, JSON.parse(run("JSON.stringify(readBrief())")), "initial-study");
  context.initial = structuredClone(canonical);
  run(`
    app.run = initial;
    app.selected = initial.treatments[0].id;
    app.sessionStatus = "active";
    app.health = { qlooConfigured: true };
    app.dataMode = initial.dataMode;
    $("#data-mode").value = initial.dataMode;
    app.shots[app.selected] = [{label: "Personal framing", note: "Leave space for the cover title."}];
    $("#project-name").value = "My edited title";
    $("#creative-intent").value = "Keep the subject's gesture.";
    renderResults();
  `);
  return {
    run,
    calls,
    downloads,
    element,
    stored: () => JSON.parse(stored),
    async selectMode(value) {
      element("#data-mode").value = value;
      await element("#data-mode").dispatch("change");
    },
  };
}

for (const [currentMode, nextMode] of [["live", "fixture"], ["fixture", "live"]]) {
  test(`${currentMode} → ${nextMode} pauses all revisions without touching the old study or notes`, async () => {
    const w = workspace(currentMode);
    await w.selectMode(nextMode);
    w.element("#city").value = "Lisbon";
    await w.element("#city").dispatch("change");
    w.run('app.references[0] = { query: "Another reference", domain: "movie" }; markDirty();');
    await w.element("#apply-references").dispatch("click");
    for (const type of ["lock", "unlock", "veto", "change-reference", "change-city"]) {
      assert.equal(await w.run(`revise({type: "${type}", targetId: currentTreatment().id})`), false);
    }
    w.run("showVeto(currentTreatment().candidateId); setBusy(true); setBusy(false);");

    assert.equal(w.calls.length, 0);
    assert.equal(w.element("#detail-dialog").open, false);
    assert.equal(w.element("#apply-references").disabled, true);
    assert.equal(w.run("app.run.dataMode"), currentMode);
    assert.equal(w.run("app.run.revision"), 1);
    assert.equal(w.run("readBrief().city"), "Lisbon");
    assert.equal(w.run("readBrief().title"), "My edited title");
    assert.equal(w.run("readBrief().note"), "Keep the subject's gesture.");
    assert.equal(w.run("app.shots[app.selected][0].note"), "Leave space for the cover title.");
    assert.equal(w.stored().dataMode, nextMode);
    assert.equal(w.stored().run.dataMode, currentMode);
    assert.equal(w.stored().brief.city, "Lisbon");
    assert.match(w.element("#study-output").innerHTML, /RE-SCOUT REQUIRED/);
    assert.match(w.element("#study-output").innerHTML, currentMode === "live" ? /QLOO LIVE STUDY/ : /SAMPLE STUDY/);
    assert.match(w.element("#connection-status").innerHTML, /Next study:/);
    const candidate = w.run("candidateMarkup(currentTreatment().candidate, 0)");
    assert.match(candidate, /data-lock="[^"]+" disabled/);
    assert.match(candidate, /data-veto="[^"]+" disabled/);
  });
}

test("explicit re-scout uses the newly selected mode and preserves edited notes separately", async () => {
  const w = workspace("live");
  w.run("app.run.locks = [app.selected]; app.run.treatments[0].locked = true; app.checks.permission = true;");
  await w.selectMode("fixture");
  w.element("#city").value = "Lisbon";
  await w.element("#city").dispatch("change");
  await w.run("generate()");

  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].path, "/api/rehearse");
  assert.equal(w.calls[0].body.dataMode, "fixture");
  assert.equal(w.calls[0].body.brief.city, "Lisbon");
  assert.equal(w.calls[0].body.brief.title, "My edited title");
  assert.equal(w.calls[0].body.brief.note, "Keep the subject's gesture.");
  assert.equal(w.run("app.run.dataMode"), "fixture");
  assert.equal(w.run("app.recoveredNotes[0].shots[0].note"), "Leave space for the cover title.");
  assert.equal(w.run("app.run.locks.length"), 0);
  assert.equal(w.run("Object.keys(app.checks).length"), 0);
  assert.equal(w.run("Object.keys(app.shots).length"), 0);
  assert.doesNotMatch(w.element("#study-output").innerHTML, /RE-SCOUT REQUIRED/);
  assert.doesNotMatch(w.element("#connection-status").innerHTML, /Next study:/);
  assert.equal(await w.run('revise({type: "lock", targetId: currentTreatment().id})'), true);
  assert.deepEqual(w.calls.map((call) => call.path), ["/api/rehearse", "/api/revise"]);
  assert.equal(w.run("app.run.dataMode"), "fixture");
});

test("switching back to the existing study's mode restores decisions without a re-scout", async () => {
  const w = workspace("live");
  await w.selectMode("fixture");
  await w.selectMode("live");
  assert.equal(w.calls.length, 0);
  assert.doesNotMatch(w.element("#study-output").innerHTML, /RE-SCOUT REQUIRED/);
  const candidate = w.run("candidateMarkup(currentTreatment().candidate, 0)");
  assert.doesNotMatch(candidate, /data-lock="[^"]+" disabled/);
  assert.doesNotMatch(candidate, /data-veto="[^"]+" disabled/);
  assert.equal(await w.run('revise({type: "lock", targetId: currentTreatment().id})'), true);
  assert.equal(w.calls[0].path, "/api/revise");
  assert.equal(w.run("app.run.dataMode"), "live");
  assert.equal(w.run("app.run.runId"), "initial-study");
  assert.equal(w.run("readBrief().title"), "My edited title");
  assert.equal(w.run("app.shots[app.selected][0].note"), "Leave space for the cover title.");
});

for (const action of ["lock", "unlock", "veto"]) {
  test(`${action} preserves the unapplied city and references after returning to the study's mode`, async () => {
    const w = workspace("live");
    await w.selectMode("fixture");
    w.element("#city").value = "Lisbon";
    await w.element("#city").dispatch("change");
    w.run('app.references[0] = {query: "New film reference", domain: "movie"}; markDirty();');
    await w.selectMode("live");
    assert.equal(w.calls.length, 0);

    assert.equal(await w.run(`revise({type: "${action}", targetId: currentTreatment().id})`), true);
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].body.action.type, action);
    assert.equal(w.run("app.run.brief.city"), "Barcelona");
    assert.equal(w.run("readBrief().city"), "Lisbon");
    assert.equal(w.run("readBrief().references[0].query"), "New film reference");
    assert.equal(w.run("app.run.brief.references[0].query"), "In the Mood for Love");
    assert.equal(w.run("pendingResearch()"), true);
    assert.equal(w.stored().brief.city, "Lisbon");
    assert.match(w.element("#saved-state").textContent, /NOTES CHANGED/);
    await w.run('exportBrief("json")');
    assert.equal(w.calls.length, 1, "Pending research must still block export verification");
    assert.equal(w.downloads.length, 0);
  });
}

test("applying references preserves the pending city, and applying that city completes the draft", async () => {
  const w = workspace("live");
  await w.selectMode("fixture");
  w.element("#city").value = "Lisbon";
  await w.element("#city").dispatch("change");
  w.run(`
    app.references[0] = {query: "New film reference", domain: "movie"};
    app.references[1] = {query: "New music reference", domain: "artist"};
    markDirty();
  `);
  await w.selectMode("live");
  await w.element("#apply-references").dispatch("click");
  assert.deepEqual(w.calls.map((call) => call.body.action.type), ["change-reference", "change-reference"]);
  assert.equal(w.run("readBrief().city"), "Lisbon");
  assert.equal(w.run("app.run.brief.city"), "Barcelona");
  assert.equal(w.run("readBrief().references[0].query"), "New film reference");
  assert.equal(w.run("readBrief().references[1].query"), "New music reference");
  assert.equal(w.run("pendingReferences()"), false);
  assert.equal(w.run("pendingResearch()"), true);

  await w.run('revise({type: "change-city", city: readBrief().city})');
  assert.equal(w.calls[2].body.action.type, "change-city");
  assert.equal(w.run("app.run.brief.city"), "Lisbon");
  assert.equal(w.run("readBrief().city"), "Lisbon");
  assert.equal(w.run("pendingResearch()"), false);
});

test("applying a city preserves cultural references that have not been applied yet", async () => {
  const w = workspace("live");
  w.run('app.references[0] = {query: "A still-pending film", domain: "movie"}; markDirty();');
  w.element("#city").value = "Lisbon";
  await w.run('revise({type: "change-city", city: readBrief().city})');
  assert.equal(w.run("app.run.brief.city"), "Lisbon");
  assert.equal(w.run("readBrief().city"), "Lisbon");
  assert.equal(w.run("readBrief().references[0].query"), "A still-pending film");
  assert.equal(w.run("app.run.brief.references[0].query"), "In the Mood for Love");
  assert.equal(w.run("pendingReferences()"), true);
  assert.equal(w.element("#apply-references").hidden, false);
  assert.equal(w.element("#apply-references").disabled, false);
});

test("handover exports contain current edits, while earlier-study notes remain a separate personal download", async () => {
  const w = workspace("live");
  w.run('app.shots[app.selected][0].note = "PRIVATE PRIOR CLIENT: an unreleased portrait concept.";');
  await w.selectMode("fixture");
  await w.run("generate()");
  w.run(`
    app.shots[app.selected] = [{label: "Current framing", note: "CURRENT CLIENT: leave room for the headline."}];
    showBrief();
  `);
  assert.match(w.element("#dialog-content").innerHTML, /stay separate from the brief and evidence exports/);
  assert.match(w.element("#dialog-content").innerHTML, /data-notes-export/);
  assert.match(w.element("#dialog-content").innerHTML, /PRIVATE PRIOR CLIENT/);

  await w.run('exportBrief("markdown")');
  await w.run('exportBrief("json")');
  assert.equal(w.downloads.length, 2);
  for (const download of w.downloads) {
    const content = await download.blob.text();
    assert.match(content, /CURRENT CLIENT: leave room for the headline/);
    assert.doesNotMatch(content, /PRIVATE PRIOR CLIENT|Unassigned notes from an earlier study|recoveredCreativeNotes/);
  }
  const evidence = JSON.parse(await w.downloads[1].blob.text());
  assert.equal(Object.hasOwn(evidence, "recoveredCreativeNotes"), false);
  assert.equal(evidence.editedShots["new-study:a"][0].note, "CURRENT CLIENT: leave room for the headline.");

  w.run("exportNotes()");
  const personal = await w.downloads[2].blob.text();
  assert.match(personal, /PERSONAL NOTES ONLY/);
  assert.match(personal, /PRIVATE PRIOR CLIENT: an unreleased portrait concept/);
  assert.match(personal, /CURRENT CLIENT: leave room for the headline/);
  assert.equal(w.run("app.recoveredNotes[0].shots[0].note"), "PRIVATE PRIOR CLIENT: an unreleased portrait concept.");
  assert.equal(w.stored().recoveredNotes[0].shots[0].note, "PRIVATE PRIOR CLIENT: an unreleased portrait concept.");
});

test("readable evidence preserves every saved field and its precision inside escaped raw details", () => {
  const w = workspace("live");
  w.run(`
    const candidate = currentTreatment().candidate;
    candidate.affinityRaw = 0.827463821987;
    candidate.rank = 3;
    candidate.explanation = {
      supportingData: [{
        entityId: "hidden-supporting-reference-id",
        value: 0.123456789123,
        note: "</pre><script>not executable</script>"
      }]
    };
    candidate.sourceQuery = {"signal.interests.entities": ["original-reference-id"]};
    currentTreatment().editorial.source = "model-proposed";
    currentTreatment().evidence = {
      source: "qloo",
      referenceNames: ["Original film <img src=x onerror=alert(1)>", "Original artist", "Original brand"],
      explanation: candidate.explanation
    };
    app.run.resolvedReferences = [{name: "Later changed reference", domain: "movie"}];
  `);
  const before = w.run("JSON.stringify(app.run)");
  w.run("showEvidence(currentTreatment().candidateId)");
  const html = w.element("#dialog-content").innerHTML;
  const readable = html.split('<details class="evidence-raw">')[0];
  assert.match(readable, /Original film &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(readable, /Original artist/);
  assert.match(readable, /Original brand/);
  assert.doesNotMatch(readable, /hidden-supporting-reference-id|supportingData|Later changed reference/);
  assert.match(readable, /Qloo evaluates the combined reference set/);
  assert.match(readable, /individual values are not personal probabilities/);
  assert.match(readable, /Qloo API/);
  assert.match(readable, /0\.8275/);
  assert.match(readable, /#3/);
  assert.match(readable, /Creative proposal · AI-assisted/);
  assert.match(html, /<details class="evidence-raw"><summary>View raw Qloo fields<\/summary>/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  const rawText = html.match(/<details class="evidence-raw">[\s\S]*?<pre>([\s\S]*?)<\/pre>/)[1];
  const decoded = rawText.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity],
  );
  const fields = JSON.parse(decoded);
  const runBefore = JSON.parse(before);
  assert.deepEqual(fields.candidate, runBefore.candidates[0]);
  assert.deepEqual(fields.treatmentEvidence, runBefore.treatments[0].evidence);
  assert.equal(fields.candidate.affinityRaw, 0.827463821987);
  assert.equal(fields.candidate.explanation.supportingData[0].value, 0.123456789123);
  assert.equal(w.run("JSON.stringify(app.run)"), before, "Presentation must not round or rewrite saved/exported evidence");
  assert.equal(w.calls.length, 0);
});

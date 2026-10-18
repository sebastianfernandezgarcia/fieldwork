const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const e = escapeHtml;
const evidenceText = (value) =>
  typeof value === "object" && value !== null
    ? JSON.stringify(value, null, 2)
    : String(value ?? "");
const STORAGE = "fieldwork.workspace.v1";
const defaults = {
  id: "quiet-city",
  title: "After the rain",
  city: "Barcelona",
  purpose: "editorial_portrait",
  references: [
    { query: "In the Mood for Love", domain: "movie" },
    { query: "Khruangbin", domain: "artist" },
    { query: "Aesop", domain: "brand" },
  ],
  note: "An intimate portrait series. Reflective, unhurried, quietly cinematic.",
  placeKinds: ["gallery", "bookshop"],
  avoidEntityIds: [],
};
const app = {
  run: null,
  selected: null,
  health: null,
  examples: [],
  briefBase: structuredClone(defaults),
  references: structuredClone(defaults.references),
  shots: {},
  checks: {},
  journal: [],
  busy: false,
  dataMode: "fixture",
  requestId: 0,
  dirty: false,
  sessionStatus: "none",
  sessionCheckedAt: null,
  recoveredNotes: [],
};
let toastTimer;
let lastDialogTrigger;
const domainLabels = {
  movie: "FILM",
  artist: "MUSIC",
  brand: "BRAND",
  book: "BOOK",
  tv_show: "TV",
  podcast: "PODCAST",
};
const domainSymbols = {
  movie: "F",
  artist: "M",
  brand: "B",
  book: "B",
  tv_show: "TV",
  podcast: "P",
};

async function api(path, body, signal) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The scouting service did not return a readable response. Your notes are still here.",
    );
  }
  if (!response.ok) {
    const error = new Error(
      data.error?.message || "The scouting request could not be completed.",
    );
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function message(text, isError = false) {
  const box = $("#global-message");
  box.textContent = text || "";
  box.classList.toggle("error", isError);
  box.hidden = !text;
}
function persist() {
  try {
    localStorage.setItem(
      STORAGE,
      JSON.stringify({
        run: app.run,
        selected: app.selected,
        shots: app.shots,
        checks: app.checks,
        journal: app.journal,
        brief: readBrief(),
        dataMode: app.dataMode,
        recoveredNotes: app.recoveredNotes,
      }),
    );
  } catch {
    /* The workspace still works when browser storage is unavailable. */
  }
}
function sessionReady() {
  return app.sessionStatus === "active";
}
function sessionNotice() {
  if (!app.run || sessionReady()) return "";
  const expired = app.sessionStatus === "expired";
  return `<div class="session-notice" role="status"><span class="eyebrow">${expired ? "SESSION EXPIRED" : app.sessionStatus === "checking" ? "CHECKING SAVED STUDY" : "SAVED COPY / NOT VERIFIED"}</span><h3>Your notes are still here.</h3><p>${expired ? "The server no longer has this study. What you see below is a saved copy, not current verified evidence. Re-scout to make new decisions." : "We have not confirmed this saved study with the server. Decisions and evidence exports are paused; your brief and shot notes remain editable."}</p><div class="session-actions">${app.sessionStatus === "checking" ? "" : `<button type="button" class="text-link" data-session-rescout>Re-scout with my notes ↗</button>${expired ? "" : '<button type="button" class="text-link" data-session-retry>Check saved study again ↗</button>'}`}<button type="button" class="text-link" data-notes-export>Save my notes ↗</button></div><p class="privacy-note">Re-scouting makes a new shortlist. Previous keeps and practical checks will not carry over; edited shot notes stay available as unassigned notes.</p></div>`;
}
function wireSessionActions(root) {
  $$("[data-session-rescout]", root).forEach((button) => button.addEventListener("click", () => {
    closeDialog();
    generate();
  }));
  $$("[data-session-retry]", root).forEach((button) => button.addEventListener("click", async () => {
    if (app.busy) return;
    const reopen = $("#detail-dialog").open;
    closeDialog();
    setBusy(true);
    await validateSession();
    setBusy(false);
    if (reopen) showBrief();
  }));
  $$("[data-notes-export]", root).forEach((button) => button.addEventListener("click", exportNotes));
}
async function validateSession({ forExport = false } = {}) {
  const previous = app.run;
  if (!previous) return false;
  app.sessionStatus = "checking";
  renderResults();
  try {
    const canonical = await api(`/api/briefs/${encodeURIComponent(previous.runId)}${forExport ? "/export" : ""}`);
    if (canonical.schemaVersion !== "fieldwork.run.v1" || canonical.runId !== previous.runId)
      throw new Error("The saved study could not be verified. Your notes are preserved.");
    const currentIds = new Set(canonical.treatments.map((item) => item.id));
    const recoveredKeys = new Set(app.recoveredNotes.map((item) => JSON.stringify(item)));
    for (const retired of previous.treatments.filter((item) => !currentIds.has(item.id))) {
      if (!app.shots[retired.id]) continue;
      const notes = {
        previousDirection: retired.title,
        previousLocation: retired.candidate?.name || "Unspecified",
        shots: structuredClone(app.shots[retired.id]),
      };
      const key = JSON.stringify(notes);
      if (!recoveredKeys.has(key)) {
        app.recoveredNotes.push(notes);
        recoveredKeys.add(key);
      }
      delete app.shots[retired.id];
    }
    app.run = canonical;
    if (!currentIds.has(app.selected)) app.selected = canonical.treatments[0]?.id || null;
    app.sessionStatus = "active";
    app.sessionCheckedAt = new Date().toISOString();
    renderResults();
    persist();
    if (forExport && canonical.revision !== previous.revision) {
      message("A newer revision was recovered from the server. Review it before exporting again.");
      return false;
    }
    return true;
  } catch (error) {
    app.sessionStatus = error.code === "SESSION_EXPIRED" ? "expired" : "unavailable";
    app.sessionCheckedAt = null;
    renderResults();
    persist();
    if (error.code !== "SESSION_EXPIRED")
      message("The saved study cannot be verified right now. Your notes are preserved; check the connection and try again.", true);
    return false;
  }
}
function editedShotNotes() {
  return (app.run?.treatments || []).filter((item) => app.shots[item.id]).map((item) => ({
    previousDirection: item.title,
    previousLocation: item.candidate?.name || "Unspecified",
    shots: structuredClone(app.shots[item.id]),
  }));
}
function recoveredNotesMarkdown(notes = app.recoveredNotes) {
  return notes.length ? ["## Unassigned notes from an earlier study", "These are your saved creative notes. They are not assigned to the current locations and contain no verified evidence.", ...notes.flatMap((item) => ["", `### ${item.previousDirection} (previous location: ${item.previousLocation})`, ...item.shots.map((shot) => `- ${shot.label}: ${shot.note}`)]), ""] : [];
}
function downloadFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportNotes() {
  const brief = readBrief();
  downloadFile([
    `# ${brief.title}`, "", "FIELDWORK / PERSONAL NOTES ONLY", "No server-verified location evidence, keeps or practical checks are included.", "",
    `${brief.city} · ${brief.purpose.replaceAll("_", " ")}`, brief.note, "", "## References to explore",
    ...brief.references.map((reference) => `- ${reference.query} (${reference.domain})`), "",
    ...recoveredNotesMarkdown([...app.recoveredNotes, ...editedShotNotes()]),
  ].join("\n"), "fieldwork-personal-notes.md", "text/markdown;charset=utf-8");
  toast("Personal notes saved. No verified evidence is claimed.");
}

function log(title, detail = "") {
  app.journal.unshift({ title, detail, at: new Date().toISOString() });
  app.journal = app.journal.slice(0, 30);
  renderJournal();
}
function renderJournal() {
  if (!app.journal.length) {
    $("#journal-list").innerHTML =
      '<li><span class="journal-number">00</span><div><strong>A blank page is a good start.</strong><p>Your scouting decisions will appear here.</p></div><time>NOW</time></li>';
    return;
  }
  $("#journal-list").innerHTML = app.journal
    .map(
      (entry, index) =>
        `<li><span class="journal-number">${String(app.journal.length - index).padStart(2, "0")}</span><div><strong>${e(entry.title)}</strong><p>${e(entry.detail)}</p></div><time datetime="${e(entry.at)}">${e(new Date(entry.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }))}</time></li>`,
    )
    .join("");
}

function renderReferences() {
  $("#reference-fields").innerHTML = app.references
    .map(
      (ref, index) =>
        `<div class="reference-field"><label for="reference-${index}" class="visually-hidden">${e(domainLabels[ref.domain] || ref.domain)} reference</label><span class="reference-type" aria-hidden="true">${e(domainSymbols[ref.domain] || "R")}</span><input id="reference-${index}" data-reference-index="${index}" maxlength="80" value="${e(ref.query)}" autocomplete="off" aria-autocomplete="list" aria-expanded="false" aria-controls="search-${index}" placeholder="${e(domainLabels[ref.domain] || "Cultural")} reference">${ref.entityId ? '<span class="reference-resolved" title="Selected entity"></span>' : ""}<div id="search-${index}" class="search-results" hidden></div></div>`,
    )
    .join("");
  $$("[data-reference-index]").forEach((input) => {
    let timer;
    let controller;
    input.addEventListener("input", () => {
      const index = Number(input.dataset.referenceIndex);
      app.references[index] = {
        query: input.value,
        domain: app.references[index].domain,
      };
      markDirty();
      input.nextElementSibling?.classList.contains("reference-resolved") &&
        input.nextElementSibling.remove();
      clearTimeout(timer);
      controller?.abort();
      const results = $(`#search-${index}`);
      results.hidden = true;
      input.setAttribute("aria-expanded", "false");
      if (input.value.trim().length < 2) return;
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          const data = await api(
            `/api/search?query=${encodeURIComponent(input.value.trim())}&domain=${encodeURIComponent(app.references[index].domain)}&dataMode=${app.dataMode}`,
            null,
            controller.signal,
          );
          if (document.activeElement !== input) return;
          const candidates = data.candidates || [];
          results.innerHTML = candidates.length
            ? candidates
                .slice(0, 5)
                .map(
                  (candidate, i) =>
                    `<button type="button" data-result="${i}">${e(candidate.name)}<small>${e(candidate.disambiguation || candidate.domain)} · ${candidate.source === "qloo" ? "Qloo entity" : "sample reference"}</small></button>`,
                )
                .join("")
            : '<div class="search-note">No matching entity found. Try the exact title or another reference.</div>';
          results.hidden = false;
          input.setAttribute("aria-expanded", "true");
          $$("[data-result]", results).forEach((button) =>
            button.addEventListener("click", () => {
              const candidate = candidates[Number(button.dataset.result)];
              app.references[index] = {
                query: candidate.name,
                domain: candidate.domain || app.references[index].domain,
                entityId: candidate.id,
              };
              renderReferences();
              markDirty();
              $(`#reference-${index}`).focus();
            }),
          );
        } catch (error) {
          if (error.name !== "AbortError") {
            results.innerHTML = `<div class="search-note">${e(error.message)}</div>`;
            results.hidden = false;
            input.setAttribute("aria-expanded", "true");
          }
        }
      }, 280);
    });
    input.addEventListener("keydown", (event) => {
      const results = $(`#search-${input.dataset.referenceIndex}`);
      if (event.key === "Escape") {
        results.hidden = true;
        input.setAttribute("aria-expanded", "false");
      }
      if (event.key === "ArrowDown" && !results.hidden) {
        event.preventDefault();
        $("button", results)?.focus();
      }
    });
  });
}

function setBrief(brief) {
  app.briefBase = structuredClone({ ...defaults, ...brief });
  $("#project-name").value = brief.title || defaults.title;
  $("#city").value = brief.city || defaults.city;
  $("#creative-intent").value = brief.note || "";
  $("#shoot-style").value = brief.purpose || defaults.purpose;
  app.references = (
    brief.references?.length ? brief.references : defaults.references
  ).map((ref) => ({ ...ref }));
  renderReferences();
  $("#apply-references").hidden = true;
}
function readBrief() {
  return {
    ...defaults,
    ...app.briefBase,
    title: $("#project-name").value.trim() || "Untitled field study",
    city: $("#city").value,
    purpose: $("#shoot-style").value,
    note: $("#creative-intent").value.trim(),
    references: app.references.map((ref) => ({
      ...ref,
      query: ref.query.trim(),
    })),
  };
}
function markDirty() {
  persist();
  app.dirty = !!app.run;
  $("#saved-state").textContent = app.run
    ? "NOTES CHANGED · RE-SCOUT"
    : "YOUR STARTING POINT";
  $("#generate-button span:first-child").textContent = app.run
    ? "Re-scout my direction"
    : "Find my direction";
  $("#apply-references").hidden =
    !app.run || !sessionReady() ||
    !app.references.some(
      (ref, index) =>
        ref.query !== app.run.brief.references[index]?.query ||
        ref.entityId !== app.run.brief.references[index]?.entityId,
    );
}
function currentTreatment() {
  return (
    app.run?.treatments?.find((treatment) => treatment.id === app.selected) ||
    app.run?.treatments?.[0]
  );
}
function findCandidate(id) {
  return (
    app.run?.candidates?.find((item) => item.id === id) ||
    app.run?.treatments?.find((item) => item.candidateId === id)?.candidate
  );
}
function pendingReferences() {
  return (
    !!app.run &&
    app.references.some(
      (reference, index) =>
        reference.query !== app.run.brief.references[index]?.query ||
        reference.entityId !== app.run.brief.references[index]?.entityId,
    )
  );
}
function pendingResearch() {
  return !!app.run && (pendingReferences() || readBrief().city !== app.run.brief.city || readBrief().purpose !== app.run.brief.purpose || app.dataMode !== app.run.dataMode);
}
function creativeLabel(treatment) {
  return treatment?.editorial?.source === "model-proposed" ? "Creative proposal · AI-assisted" : "Authored creative proposal";
}
function plannerLabel(provenance) {
  return ({ groq: "Groq model planner", "groq-with-policy-fallback": "Groq model planner with explicit policy fallback", "bounded-policy-v1": "Bounded policy planner", "local-ollama": "Local Ollama model planner" })[provenance?.planner] || provenance?.planner || "Bounded policy planner";
}

function reviewRequired() {
  return !!app.run?.treatments?.some((treatment) => treatment.needsReview);
}
function checkKey(itemKey) {
  return `${app.run.runId}:${currentTreatment().candidateId}:${app.run.brief.city}:${itemKey}`;
}
function setBusy(value) {
  app.busy = value;
  $$("input,select,textarea,button", $("#brief-form")).forEach(
    (control) => (control.disabled = value),
  );
  $("#reset-session").disabled = value;
  $("#open-brief-nav").disabled = value;
  $("#choose-brief").disabled = value || !app.examples.length;
}

function showExampleBriefs() {
  if (app.busy || !app.examples.length) return;
  openDialog(
    "THE STARTING POINTS / SAMPLE BRIEFS",
    `<h2 id="dialog-title">Three ways<br>into a story.</h2>
    <p class="dialog-lede">Different references. Different places to start. Each sample uses fictional locations and no live Qloo results.</p>
    ${app.run ? '<div class="message">Choosing a sample replaces the study saved on this device, including kept directions, edited shots, checks and its journal. Close this window to keep your current study, or export it first.</div>' : '<p class="privacy-note">Choose a starting point, make the notes yours, then scout it in Sample mode.</p>'}
    <div class="example-brief-list">${app.examples
      .map(
        (brief, index) => `<article class="example-brief">
          <span class="example-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
          <div class="example-content">
            <p class="example-meta">SAMPLE / ${e(brief.city)}</p>
            <h3>${e(brief.title)}</h3>
            <p class="example-note">${e(brief.note)}</p>
            <ul class="example-references" aria-label="Cultural references">${brief.references
              .map(
                (reference) =>
                  `<li><span>${e(domainLabels[reference.domain] || reference.domain)}</span> ${e(reference.query)}</li>`,
              )
              .join("")}</ul>
            <button type="button" class="text-link use-example" data-example-index="${index}">Use ${e(brief.city)} brief ↗</button>
          </div>
        </article>`,
      )
      .join("")}</div>`,
  );
  $$("[data-example-index]").forEach((button) =>
    button.addEventListener("click", () => {
      const brief = app.examples[Number(button.dataset.exampleIndex)];
      if (!brief || app.busy) return;
      closeDialog();
      app.run = null;
      app.sessionStatus = "none";
      app.recoveredNotes = [];
      app.selected = null;
      app.shots = {};
      app.checks = {};
      app.journal = [];
      app.dirty = false;
      app.dataMode = "fixture";
      $("#data-mode").value = "fixture";
      setBrief(brief);
      renderEmpty();
      renderJournal();
      renderConnection();
      message("");
      $("#saved-state").textContent = "READY TO SCOUT · SAMPLE";
      $("#generate-button span:first-child").textContent = "Find my direction";
      persist();
      $("#project-name").focus();
      toast(`${brief.city} sample loaded. Make it yours, then find your direction.`);
    }),
  );
}
function assetFor(treatment) {
  const index =
    app.run?.treatments?.findIndex((item) => item.id === treatment?.id) || 0;
  return index === 1 ? "/assets/mood-detail.jpg" : "/assets/mood-wide.jpg";
}
function renderConnection() {
  const live = app.dataMode === "live";
  const cloud = app.health?.planner === "groq" && app.health?.plannerConfigured;
  const notes = [live ? "Live scouting sends your references and city to Qloo." : "", cloud ? "Your brief, references and candidate places go to Groq for creative planning." : app.health?.planner === "local-ollama" ? "Creative planning runs on this device." : "", live || cloud ? "Keep private client information out of your brief." : ""].filter(Boolean);
  $("#data-use-note").textContent = notes.join(" ");
  $("#data-use-note").hidden = !notes.length;
  $("#connection-status").innerHTML =
    `<span class="status-dot ${live && app.health?.qlooConfigured ? "live" : ""}"></span><span>${live ? (app.health?.qlooConfigured ? "Qloo live connection configured. Each result carries its source." : "Qloo live is not connected. Switch to Sample to explore the workflow.") : "Sample workspace. Fictional places; no live Qloo results."}</span>`;
}
function renderEmpty() {
  $("#study-output").innerHTML =
    `<div class="study-cover"><img src="/assets/mood-wide.jpg" alt="Illustrative coastal mood study in blue hour, made with AI" fetchpriority="high"><span class="cover-label">THE FEELING BEFORE THE FRAME</span><span class="cover-count">STUDY / 001</span><div class="cover-text"><span class="eyebrow">A PLACE TO BEGIN</span><h2>Not just where.<br>Why <em>there.</em></h2></div></div><p class="photo-credit">Illustrative mood study · AI-generated · Not a location photograph</p><div class="empty-note"><span class="large-number">01</span><div><h3>Give your references somewhere to go.</h3><p>Start with three cultural references. Fieldwork builds two creative treatments, keeps the research visible, and helps you adapt when a location falls through.</p><button type="button" class="text-link" id="try-example">Explore the sample study ↗</button></div></div>`;
  $("#try-example")?.addEventListener("click", () => {
    app.dataMode = "fixture";
    $("#data-mode").value = "fixture";
    renderConnection();
    generate();
  });
}
function renderBusy(kind = "scout") {
  $("#study-output").innerHTML =
    `<div class="busy-panel"><span class="eyebrow">${kind === "revise" ? "A NEW WAY THROUGH" : "THE RESEARCH IS TAKING SHAPE"}</span><h2>${kind === "revise" ? "Keep the feeling.<br>Change the plan." : "Connecting references<br>to possibilities."}</h2><p>${app.dataMode === "fixture" ? "Exploring a clearly labelled sample dataset. This demonstrates the workflow, not live Qloo recommendations." : "Resolving your references and asking Qloo for cultural affinity. We will show what the response actually supports."}</p><div class="progress-line" aria-hidden="true"></div><ul class="loading-steps"><li>Resolve cultural references</li><li>Inspect the candidate pool</li><li>Build two editable directions</li></ul>${kind === "revise" && app.run?.locks?.length ? `<p class="retained-note">${app.run.locks.length} kept direction${app.run.locks.length > 1 ? "s" : ""} carried forward</p>` : ""}</div>`;
}

function candidateAddress(candidate) {
  if (typeof candidate.address === "string") return candidate.address;
  if (candidate.address && typeof candidate.address === "object")
    return [
      candidate.address.neighborhood,
      candidate.address.locality,
      candidate.address.city,
    ]
      .filter(Boolean)
      .join(", ");
  return (
    candidate.city ||
    candidate.sourceQuery?.city ||
    candidate.sourceQuery?.["filter.location.query"] ||
    "LOCATION DETAILS UNVERIFIED"
  );
}
function candidateMarkup(candidate, index, { featured = false } = {}) {
  const treatment = app.run.treatments.find(
    (item) => item.candidateId === candidate.id,
  );
  const isLocked = !!(
    treatment?.locked || app.run.locks?.includes(treatment?.id)
  );
  const isFixture = candidate.source !== "qloo";
  const reason = !sessionReady()
    ? "A location in your saved copy. Re-scout or reconnect before treating it as verified research."
    : typeof candidate.explanation === "object" && candidate.explanation !== null
      ? "Qloo returned structured supporting data. Open the reasoning to inspect the response."
      : candidate.explanation ||
        candidate.description ||
        (isFixture
          ? "A fictional setting used to demonstrate the scouting workflow."
          : "A place returned by Qloo for the selected cultural references. Scout it before committing to a shoot.");
  return `<article class="candidate ${featured ? "candidate-featured" : ""}"><span class="candidate-number">${String(index + 1).padStart(2, "0")}</span><div><h3 class="candidate-name">${e(candidate.name)}</h3><p class="candidate-category">${e(candidate.kind || "Place")} · ${e(candidateAddress(candidate))}${isFixture ? " · FICTIONAL PLACE" : ""}</p><p class="candidate-reason">${e(reason)}</p><div class="candidate-bottom"><button type="button" class="text-link" data-evidence="${e(candidate.id)}">See the reasoning ↗</button><span class="data-tag ${isLocked ? "keep" : ""}">${!sessionReady() ? "SAVED COPY / UNVERIFIED" : isLocked ? "KEPT IN THIS STUDY" : isFixture ? "SAMPLE RECORD" : "QLOO RESULT"}</span>${treatment?.needsReview ? '<span class="data-tag">REVIEW AFTER CHANGE</span>' : ""}</div></div><div class="candidate-actions">${treatment ? `<button type="button" class="small-button ${isLocked ? "active" : ""}" data-lock="${e(treatment.id)}" ${!sessionReady() ? "disabled" : ""} aria-pressed="${isLocked}" aria-label="${isLocked ? "Release" : "Keep"} ${e(candidate.name)}"><span aria-hidden="true">${isLocked ? "✓" : "+"}</span> ${isLocked ? "Kept" : "Keep"}</button>` : ""}<button type="button" class="small-button danger" data-veto="${e(candidate.id)}" ${!sessionReady() ? "disabled" : isLocked ? 'disabled title="Release this kept direction before ruling it out"' : ""} aria-label="${isLocked ? "Release the keep before ruling out" : "Rule out"} ${e(candidate.name)}">Rule out <span aria-hidden="true">×</span></button></div></article>`;
}
function renderResults() {
  const run = app.run;
  if (!run) {
    renderEmpty();
    return;
  }
  const treatment = currentTreatment();
  if (treatment) app.selected = treatment.id;
  const sample = run.dataMode !== "live" || !run.provenance?.qlooUsed;
  const pool = run.candidates || [];
  const selected =
    treatment?.candidate ||
    pool.find((candidate) => candidate.id === treatment?.candidateId);
  const alternatives = pool
    .filter((candidate) => candidate.id !== selected?.id)
    .slice(0, 2);
  const excluded = (run.decisions || []).filter(
    (decision) => decision.type === "veto",
  );
  $("#saved-state").textContent =
    `REV. ${String(run.revision || 1).padStart(2, "0")} · ${!sessionReady() ? "SAVED COPY / UNVERIFIED" : sample ? "SAMPLE STUDY" : "QLOO LIVE"}`;
  $("#generate-button span:first-child").textContent = "Re-scout my direction";
  const issues = (run.resolutionIssues || []).length;
  $("#study-output").innerHTML =
    `${sessionNotice()}<div class="sample-banner"><strong>${!sessionReady() ? "SAVED STUDY / UNVERIFIED" : sample ? "SAMPLE STUDY" : "QLOO LIVE STUDY"}</strong><p>${!sessionReady() ? "This local copy has not been verified with the server. Your creative notes remain available; its saved research claims are not current evidence." : sample ? "Fictional places and creative proposals. No Qloo affinity scores are implied." : "Places and affinity come from Qloo. Creative treatments are authored interpretations; access and shooting conditions remain unverified."}</p></div>${issues ? `<div class="message"><strong>${issues} reference${issues > 1 ? "s need" : " needs"} a closer look.</strong> ${run.resolutionIssues.map((issue) => e(issue.query) + ": " + e(issue.reason)).join(" ")} Edit the references and try again.</div>` : ""}${
      treatment
        ? `
    <div class="treatment-tabs" role="tablist" aria-label="Creative directions">${run.treatments.map((item, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="treatment-panel" aria-selected="${item.id === treatment.id}" class="treatment-tab" data-treatment="${e(item.id)}"><span class="treatment-code">${String.fromCharCode(65 + index)}</span><span><strong>${e(item.title)}</strong><small>${item.locked ? "KEPT · " : ""}${e(item.candidate?.kind || "LOCATION DIRECTION")}</small></span><span class="tab-arrow" aria-hidden="true">${item.id === treatment.id ? "↗" : "→"}</span></button>`).join("")}</div>
    <div id="treatment-panel" role="tabpanel" aria-labelledby="tab-${run.treatments.indexOf(treatment)}">${treatment.needsReview ? '<div class="message"><strong>This kept direction needs a new review.</strong> The city or references changed. It is retained from the earlier brief, not a fresh recommendation for the current one.</div>' : ""}<div class="study-cover"><img src="${assetFor(treatment)}" alt="AI-generated illustrative mood study, not a photograph of the recommended location"><span class="cover-label">CREATIVE DIRECTION / ${String.fromCharCode(65 + run.treatments.indexOf(treatment))}</span><span class="cover-count">${treatment.needsReview ? "EARLIER BRIEF / REVIEW" : e(run.brief.city.toUpperCase())}</span><div class="cover-text"><span class="eyebrow">${e(treatment.tagline || "AN EDITABLE POINT OF VIEW")}</span><h2>${e(treatment.title)}</h2></div></div><p class="photo-credit">Illustrative mood study · AI-generated · Not a location photograph</p>
    <div class="study-intro"><div><span class="eyebrow">${e(run.brief.title)}</span><h2>A reason<br>to be here.</h2></div><p><small class="creative-credit">${e(creativeLabel(treatment))}<br>Ideas to test on a scout. Lighting, layout and access have not been verified.</small>${e(treatment.editorial?.premise || "An authored creative direction, grounded in the selected references. Explore it on location before making a commitment.")}</p></div>
    <div class="study-meta"><span>01 / SELECTED DIRECTION</span><span>THE EVIDENCE STAYS ATTACHED</span></div><div class="candidate-list">${selected ? candidateMarkup(selected, 0, { featured: true }) : ""}</div>
    ${alternatives.length ? `<div class="study-meta"><span>02 / OTHER POSSIBILITIES</span><span>${pool.length} PLACES IN THE WORKING POOL</span></div><div class="candidate-list">${alternatives.map((candidate, index) => candidateMarkup(candidate, index + 1)).join("")}</div>` : ""}
    </div>
    <div class="result-actions"><button type="button" class="text-link" id="compare-rankings">What changed with taste signals? ↗</button><button type="button" class="button button-secondary" id="inspect-process">Research trail <span aria-hidden="true">↗</span></button></div>
    ${excluded.length ? `<p class="veto-strip">${excluded.length} place${excluded.length > 1 ? "s" : ""} ruled out. ${e(excluded.at(-1)?.reason || "Removed from this study.")} Kept directions stay in the brief.</p>` : ""}
    <div class="shoot-preview"><div><span class="eyebrow">FROM THE STUDY TO THE SHOOT</span><h3>Make the brief yours.</h3><p>Edit the shot plan. Check practical details. Export a brief that another person can pick up.</p></div><button class="brief-arrow" type="button" id="open-shoot-brief" aria-label="Open and edit shoot brief">↗</button></div>
    `
        : `<div class="empty-candidates"><h3>Let's give this another angle.</h3><p>${e(run.warnings?.[0] || "There are not enough resolved places to build two useful directions. Try a different reference or city.")}</p><button class="button button-secondary" id="edit-references" type="button">Revisit the references ↖</button></div>`
    }`;
  $$("[data-treatment]").forEach((button) =>
    button.addEventListener("click", () => {
      app.selected = button.dataset.treatment;
      renderResults();
      persist();
      $(`[data-treatment="${CSS.escape(app.selected)}"]`)?.focus();
    }),
  );
  $$("[data-treatment]").forEach((button) =>
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const tabs = $$("[data-treatment]");
      const index = tabs.indexOf(button);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      tabs[next].click();
    }),
  );
  $$("[data-evidence]").forEach((button) =>
    button.addEventListener("click", () =>
      showEvidence(button.dataset.evidence),
    ),
  );
  $$("[data-lock]").forEach((button) =>
    button.addEventListener("click", () => {
      const item = run.treatments.find((t) => t.id === button.dataset.lock);
      revise(
        {
          type: item?.locked ? "unlock" : "lock",
          targetId: button.dataset.lock,
        },
        item?.locked ? "Direction released" : "Direction kept",
      );
    }),
  );
  $$("[data-veto]").forEach((button) =>
    button.addEventListener("click", () => showVeto(button.dataset.veto)),
  );
  wireSessionActions($("#study-output"));
  $("#compare-rankings")?.addEventListener("click", showComparison);
  $("#inspect-process")?.addEventListener("click", showProcess);
  $("#open-shoot-brief")?.addEventListener("click", showBrief);
  $("#edit-references")?.addEventListener("click", () =>
    $("#reference-0").focus(),
  );
}

async function generate() {
  if (app.busy) return;
  const brief = readBrief();
  if (brief.references.some((ref) => !ref.query)) {
    message("Give each cultural reference a name before scouting.", true);
    $$("[data-reference-index]")
      .find((input) => !input.value.trim())
      ?.focus();
    return;
  }
  if (app.dataMode === "live" && !app.health?.qlooConfigured) {
    message(
      "Qloo live is not connected yet. Select Sample to explore the full workflow with fictional data.",
      true,
    );
    return;
  }
  const previous = app.run;
  const recovered = previous && !sessionReady() ? [...app.recoveredNotes, ...editedShotNotes()] : app.recoveredNotes;
  setBusy(true);
  message("");
  renderBusy();
  try {
    const run = await api("/api/rehearse", { brief, dataMode: app.dataMode });
    app.run = run;
    app.sessionStatus = "active";
    app.sessionCheckedAt = new Date().toISOString();
    app.recoveredNotes = recovered;
    app.selected = run.treatments?.[0]?.id || null;
    app.dirty = false;
    app.shots = {};
    app.checks = {};
    app.journal = [];
    log(
      previous ? "Scouted a new study" : "Started the location study",
      `${run.brief.city} · ${run.resolvedReferences?.length || 0} resolved references · ${run.candidates?.length || 0} candidate places. ${run.dataMode === "fixture" ? "Sample data." : "Qloo live data."}${previous?.locks?.length ? " Previous locks belonged to the previous study." : ""}`,
    );
    renderResults();
    persist();
    if (run.warnings?.length) message(run.warnings.join(" "));
  } catch (error) {
    app.run = previous;
    renderResults();
    message(error.message, true);
    log("Scouting paused", error.message);
  } finally {
    setBusy(false);
  }
}
async function revise(action, title) {
  if (app.busy || !app.run || !sessionReady()) return false;
  const previous = app.run;
  const editedBrief = readBrief();
  setBusy(true);
  message("");
  if (action.type === "veto") renderBusy("revise");
  try {
    app.run = await api("/api/revise", {
      state: { runId: previous.runId, revision: previous.revision },
      action,
      briefEdits: { title: editedBrief.title, note: editedBrief.note },
    });
    if (!app.run.treatments.some((item) => item.id === app.selected))
      app.selected = app.run.treatments[0]?.id || null;
    app.dirty = false;
    setBrief({
      ...app.run.brief,
      title: editedBrief.title,
      note: editedBrief.note,
    });
    renderResults();
    if (
      ["lock", "unlock", "veto"].includes(action.type) &&
      editedBrief.references.some(
        (ref, index) =>
          ref.query !== previous.brief.references[index]?.query ||
          ref.entityId !== previous.brief.references[index]?.entityId,
      )
    ) {
      app.references = editedBrief.references;
      renderReferences();
      markDirty();
    }
    const candidate =
      previous.candidates.find((item) => item.id === action.targetId) ||
      previous.treatments.find(
        (item) =>
          item.id === action.targetId || item.candidateId === action.targetId,
      )?.candidate;
    log(
      title || "Study revised",
      `${candidate?.name ? candidate.name + ". " : ""}${action.reason || "The decision is attached to this revision."}`,
    );
    persist();
    toast(title || "Study updated");
    if (app.run.warnings?.length) message(app.run.warnings.join(" "));
    return true;
  } catch (error) {
    app.run = previous;
    renderResults();
    if (["SESSION_EXPIRED", "STALE_REVISION"].includes(error.code)) {
      await validateSession();
      if (error.code === "STALE_REVISION") message("A newer revision was recovered. Review it, then make your decision again.");
    } else message(error.message, true);
    return false;
  } finally {
    setBusy(false);
  }
}

function openDialog(eyebrow, html) {
  const dialog = $("#detail-dialog");
  if (!dialog.open) lastDialogTrigger = document.activeElement;
  $("#dialog-eyebrow").textContent = eyebrow;
  $("#dialog-content").innerHTML = html;
  if (!dialog.open) dialog.showModal();
  else $("#close-dialog").focus();
  dialog.scrollTop = 0;
}
function closeDialog() {
  $("#detail-dialog").close();
  (lastDialogTrigger?.isConnected ? lastDialogTrigger : $("#open-brief-nav")).focus();
}
function showVeto(id) {
  const candidate = findCandidate(id);
  if (!candidate) return;
  const item = app.run.treatments.find(
    (treatment) => treatment.candidateId === id,
  );
  openDialog(
    "REVISE THE STUDY",
    `<h2 id="dialog-title">A good plan<br>can change.</h2><p class="dialog-lede">Rule out <strong>${e(candidate.name)}</strong> and look for a new direction. ${item?.locked ? "Release this direction first if you want to rule it out. Other kept directions stay in place." : "Kept directions stay in place."}</p><label class="field-label" for="veto-reason">What changed?</label><select id="veto-reason"><option value="The location is unavailable for this shoot.">Location unavailable</option><option value="The client does not feel this location fits the brief.">Client preference</option><option value="Filming permission could not be confirmed.">Permission not confirmed</option><option value="The practical conditions do not work for this shoot.">Practical constraints</option><option value="Explore another creative direction.">Explore another direction</option></select><p class="privacy-note">This is your decision. Fieldwork has not verified availability, permissions or opening hours.</p><div class="export-actions"><button type="button" class="button button-secondary" id="cancel-veto">Keep exploring</button><button type="button" class="button button-accent" id="confirm-veto">Rule out & replan ↗</button></div>`,
  );
  $("#cancel-veto").addEventListener("click", closeDialog);
  $("#confirm-veto").addEventListener("click", () => {
    const reason = $("#veto-reason").value;
    closeDialog();
    revise(
      { type: "veto", targetId: id, reason },
      "Location ruled out; direction replanned",
    );
  });
}
function pauseEvidence() {
  if (sessionReady()) return false;
  openDialog("SAVED STUDY / RESEARCH PAUSED", `<h2 id="dialog-title">Evidence needs<br>a fresh check.</h2>${sessionNotice()}`);
  wireSessionActions($("#dialog-content"));
  return true;
}

function showEvidence(id) {
  if (pauseEvidence()) return;
  const candidate = findCandidate(id);
  if (!candidate) return;
  const treatment = app.run.treatments.find((item) => item.candidateId === id);
  const evidence = treatment?.evidence;
  const sample = candidate.source !== "qloo";
  openDialog(
    "RESEARCH / PROVENANCE",
    `${sessionNotice()}<h2 id="dialog-title">${e(candidate.name)}</h2><p class="dialog-lede">${sample ? "A fictional location in the sample dataset. It proves the interaction, not a Qloo recommendation." : "A place returned by Qloo. Cultural affinity is a research signal, not proof that a location looks like a film or fits a particular person."}</p><section class="evidence-section"><h3>What connects the references</h3><p>${e(evidenceText(evidence?.explanation || candidate.explanation || (sample ? "This sample links the references to a fictional shortlist so you can test selection, revision and export. No live cultural-affinity evidence has been obtained." : "Qloo returned this place for the combined reference set. No per-reference causal explanation was returned.")))}</p><p>${e((evidence?.referenceNames || app.run.resolvedReferences.map((ref) => ref.name)).join(" · "))}</p></section><section class="evidence-section evidence-grid"><div class="evidence-stat"><span>SOURCE</span><strong>${sample ? "Sample dataset" : "Qloo API"}</strong></div><div class="evidence-stat"><span>RAW AFFINITY</span><strong>${candidate.affinityRaw == null ? "Not available" : e(candidate.affinityRaw)}</strong></div><div class="evidence-stat"><span>RESULT RANK</span><strong>${sample ? "Sample ordering" : `#${e(candidate.rank || "—")}`}</strong></div><div class="evidence-stat"><span>CREATIVE DIRECTION</span><strong>${e(creativeLabel(treatment))}</strong></div></section><section class="evidence-section"><h3>What this does not establish</h3><ul><li>Visual similarity, lighting, weather or camera angles.</li><li>Permission to shoot, availability, fees or opening hours.</li><li>A personal likelihood of liking this place.</li></ul></section><div class="source-note">${e(evidence?.note || "Aggregate cultural affinity is not visual similarity or a personal probability.")}<br>Record: ${e(candidate.id)}<br>Retrieved: ${e(candidate.retrievedAt || app.run.provenance?.retrievedAt || "Not recorded")}</div>`,
  );
  wireSessionActions($("#dialog-content"));
}
function showComparison() {
  if (pauseEvidence()) return;
  const comparison = app.run.comparison;
  const candidates = app.run.candidates || [];
  const rows = comparison?.changedPositions || [];
  const sample = app.run.dataMode === "fixture";
  openDialog(
    "A CONTROLLED COMPARISON",
    `${sessionNotice()}<h2 id="dialog-title">Did taste change<br>the shortlist?</h2><p class="dialog-lede">The same candidate pool, ordered two ways: cultural affinity and popularity. This isolates the ranking difference; it does not prove which plan is better.</p><div class="sample-banner"><strong>${comparison?.available ? "COMPARISON AVAILABLE" : sample ? "SAMPLE ONLY" : "NOT AVAILABLE"}</strong><p>${e(comparison?.note || (sample ? "There are no real affinity or popularity scores in this sample. No measurable uplift is claimed." : "The API did not return comparable scores for this pool."))}</p></div>${rows.length ? `<table class="comparison-table"><thead><tr><th scope="col">PLACE</th><th scope="col">WITH TASTE</th><th scope="col">POPULARITY</th><th scope="col">SHIFT</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${e(row.name || candidates.find((item) => item.id === row.id)?.name || row.id)}</td><td>${row.tasteRank == null ? "—" : e(row.tasteRank)}</td><td>${row.popularityRank == null ? "—" : e(row.popularityRank)}</td><td class="rank-change">${row.tasteRank == null || row.popularityRank == null ? "—" : row.popularityRank - row.tasteRank > 0 ? "↑ " + (row.popularityRank - row.tasteRank) : row.popularityRank - row.tasteRank < 0 ? "↓ " + (row.tasteRank - row.popularityRank) : "="}</td></tr>`).join("")}</tbody></table>` : ""}<section class="evidence-section"><h3>How to read it</h3><p>Both rankings must use the same place IDs. Missing scores remain missing. Popularity is a baseline, not a judgement of creative quality.</p><p>${sample ? "Connect Qloo and run a live study to measure the ranking change on real returned data." : comparison?.top3Overlap != null ? `Top-three overlap: ${e(comparison.top3Overlap)}. A difference is not evidence of a better shoot.` : "A comparison will appear only when the response supports it."}</p></section><div class="source-note">Method: ${e(comparison?.method || "taste-vs-popularity")}<br>Candidate pool: ${e(comparison?.candidateSetHash || "No comparable pool recorded")}</div>`,
  );
  wireSessionActions($("#dialog-content"));
}
function showProcess() {
  if (pauseEvidence()) return;
  const run = app.run;
  openDialog(
    "THE AGENT’S WORKING NOTES",
    `${sessionNotice()}<h2 id="dialog-title">Nothing up<br>our sleeve.</h2><p class="dialog-lede">A bounded planning workflow: resolve, retrieve, select, check and revise. These are recorded steps from this study, with the data mode attached.</p><div class="sample-banner"><strong>${run.dataMode === "fixture" ? "SAMPLE EXECUTION" : "LIVE EXECUTION"}</strong><p>${e(run.provenance?.fixtureNote || "Qloo requests made by the server. Secrets stay out of the browser.")}</p></div>${(run.trace || []).map((step, index) => `<section class="evidence-section"><h3>${String(index + 1).padStart(2, "0")} / ${e(step.step)} · ${e(step.status)}</h3><p><strong>${e(step.tool)}</strong></p><p>${e(typeof step.inputSummary === "object" ? JSON.stringify(step.inputSummary) : step.inputSummary)}</p><p>${e(typeof step.outputSummary === "object" ? JSON.stringify(step.outputSummary) : step.outputSummary)}</p></section>`).join("")}<div class="source-note">Planner: ${e(plannerLabel(run.provenance))}${run.provenance?.model ? " · " + e(run.provenance.model) : ""}<br>${run.dataMode === "live" ? "Qloo requests" : "Sample provider calls"}: ${e(run.provenance?.requestCount || 0)}<br>Run: ${e(run.runId)} / revision ${e(run.revision)}</div>`,
  );
  wireSessionActions($("#dialog-content"));
}
function shotsFor(treatment) {
  return app.shots[treatment.id] || treatment.editorial?.shots || [];
}
function showBrief() {
  if (!app.run || !currentTreatment()) {
    toast(
      app.run?.status === "needs_input"
        ? "Resolve the references before preparing a shoot brief."
        : "Scout a direction first, then make the brief yours.",
    );
    $("#reference-0")?.focus();
    return;
  }
  const edited = readBrief();
  app.run.brief = { ...app.run.brief, title: edited.title, note: edited.note };
  persist();
  const treatment = currentTreatment();
  const shots = shotsFor(treatment);
  const verification = app.run.verification || [];
  openDialog(
    "THE HANDOVER / EDITABLE SHOOT BRIEF",
    `${sessionNotice()}<h2 id="dialog-title">${e(app.run.brief.title)}</h2><p class="dialog-lede">${e(treatment.title)} · ${e(app.run.brief.city)}<br>${e(app.run.brief.note)}</p>${treatment.needsReview ? '<div class="message"><strong>Review required.</strong> This kept direction comes from an earlier brief. The city or references changed; this is not a newly validated location choice.</div>' : ""}<div class="sample-banner"><strong>${app.run.dataMode === "fixture" ? "SAMPLE BRIEF" : "WORKING BRIEF"}</strong><p>${app.run.dataMode === "fixture" ? "Locations are fictional. Use this to test the workflow, not as an actual booking or location plan." : "Locations still need a practical scout. This is a creative plan, not confirmation of availability or permission."}</p></div><p class="creative-credit">${e(creativeLabel(treatment))} · Ideas to test on a scout. Lighting, layout and access have not been verified.</p><div class="brief-section-title"><h3>THE SHOT PLAN</h3><span>EDIT IN PLACE · SAVED ON THIS DEVICE</span></div>${shots.map((shot, index) => `<div class="shot-row"><span class="shot-number">${String(index + 1).padStart(2, "0")}</span><div><label for="shot-${index}">${e(shot.label)}</label><textarea id="shot-${index}" data-shot="${index}" rows="2" maxlength="1500">${e(shot.note)}</textarea><p class="shot-location">${e(treatment.candidate?.name || "Selected location")} · CREATIVE INSTRUCTION, NOT AN OBSERVED CONDITION</p></div></div>`).join("")}${app.recoveredNotes.length ? `<section class="evidence-section"><h3>Saved notes from your earlier study</h3><p>Unassigned creative notes, not evidence for these locations. Copy anything useful into the current shot plan.</p>${app.recoveredNotes.map((item) => `<h4>${e(item.previousDirection)}</h4>${item.shots.map((shot) => `<p><strong>${e(shot.label)}</strong> ${e(shot.note)}</p>`).join("")}`).join("")}</section>` : ""}<div class="brief-section-title"><h3>BEFORE THE SHOOT</h3><span>YOUR VERIFICATION</span></div><div class="brief-checklist">${(verification.length
      ? verification
      : [
          {
            key: "permission",
            label: "Confirm access and permission to photograph.",
          },
          {
            key: "timing",
            label: "Check opening hours and arrange a practical scout.",
          },
          {
            key: "conditions",
            label: "Check light, weather, accessibility and any fees.",
          },
        ]
    )
      .map(
        (item) =>
          `<label class="check-row"><input type="checkbox" data-check="${e(item.key)}" ${app.checks[checkKey(item.key)] ? "checked" : ""}><span>${e(item.label)}${item.note ? `<br><span class="privacy-note">${e(item.note)}</span>` : ""}</span></label>`,
      )
      .join(
        "",
      )}</div><div class="export-actions"><button class="button button-accent" id="export-markdown" type="button">Download the brief ↗</button><button class="button button-secondary" id="export-json" type="button">Export evidence JSON</button></div><p class="export-label">EDITABLE MARKDOWN + MACHINE-READABLE EVIDENCE. SOURCE AND SAMPLE LABELS STAY IN THE EXPORT.</p>`,
  );
  $$("[data-shot]").forEach((input) =>
    input.addEventListener("input", () => {
      app.shots[treatment.id] = shotsFor(treatment).map((shot) => ({
        ...shot,
      }));
      app.shots[treatment.id][Number(input.dataset.shot)].note = input.value;
      persist();
    }),
  );
  $$("[data-check]").forEach((input) => {
    input.checked = !!app.checks[checkKey(input.dataset.check)];
    input.addEventListener("change", () => {
      app.checks[checkKey(input.dataset.check)] = input.checked;
      persist();
    });
  });
  wireSessionActions($("#dialog-content"));
  if (!sessionReady() || app.run.status !== "ready" || pendingResearch() || reviewRequired()) {
    const warning = document.createElement("div");
    warning.className = "message";
    warning.textContent = !sessionReady()
      ? "Evidence exports are paused until the server confirms this study. Save your personal notes above, or re-scout."
      : pendingResearch()
      ? "Your scouting inputs changed. Apply reference changes or re-scout before exporting this brief."
      : reviewRequired()
        ? "A kept direction belongs to an earlier brief. Release the direction marked for review and re-scout before exporting."
        : "This study is incomplete. Resolve the references and re-scout before exporting a brief. Kept directions remain here for review.";
    $(".export-actions").before(warning);
    $("#export-markdown").disabled = true;
    $("#export-json").disabled = true;
  }
  $("#export-markdown").addEventListener("click", () =>
    exportBrief("markdown"),
  );
  $("#export-json").addEventListener("click", () => exportBrief("json"));
}
function briefMarkdown() {
  const run = app.run;
  const treatment = currentTreatment();
  const lines = [
    `# ${run.brief.title}`,
    "",
    `FIELDWORK · Revision ${run.revision} · ${run.dataMode === "fixture" ? "SAMPLE DATA: fictional places, no live Qloo results" : "QLOO LIVE DATA"}`,
    "",
    `## ${treatment.title}`,
    `${run.brief.city} · ${run.brief.purpose.replaceAll("_", " ")}`,
    "",
    run.brief.note,
    "",
    `Selected location: ${treatment.candidate?.name || "Unresolved"}`,
    "",
    ...(treatment.needsReview
      ? [
          "REVIEW REQUIRED: Kept from an earlier brief. City or references changed. This is not a fresh recommendation for the current brief.",
          "",
        ]
      : []),
    `Creative premise: ${treatment.editorial?.premise || "Authored creative direction."}`,
    "",
    "## Cultural references",
    ...(run.resolvedReferences || []).map(
      (ref) => `- ${ref.name} (${ref.domain}; source: ${ref.source})`,
    ),
    "",
    "## Shot plan",
    ...shotsFor(treatment).flatMap((shot, index) => [
      `${index + 1}. **${shot.label}**: ${shot.note}`,
    ]),
    "",
    "## Before the shoot",
    ...(run.verification || []).map(
      (item) =>
        `- [${app.checks[checkKey(item.key)] ? "x" : " "}] ${item.label} ${app.checks[checkKey(item.key)] ? "(Marked complete by the user; not independently verified.)" : "(Unverified.)"}`,
    ),
    "",
    "## Evidence and limitations",
    `Data mode: ${run.dataMode}. Qloo used: ${run.provenance?.qlooUsed ? "yes" : "no"}.`,
    treatment.evidence?.note ||
      "Aggregate cultural affinity is not visual similarity or a personal probability.",
    `${creativeLabel(treatment)}. Creative directions are interpretations to test, not observations of the venue. Mood images are AI-generated illustrations, not location photographs.`,
    "No claim is made about availability, permission, fees, opening hours, weather, lighting or individual preference.",
    "",
    `Run: ${run.runId}; revision: ${run.revision}; planner: ${run.provenance?.planner || "bounded-policy-v1"}`,
    "",
    ...recoveredNotesMarkdown(),
    "## Decision journal",
    ...app.journal.map(
      (entry) => `- ${entry.at}: ${entry.title}. ${entry.detail}`,
    ),
    "",
  ];
  return lines.join("\n");
}
async function exportBrief(format) {
  if (
    app.busy ||
    !sessionReady() ||
    app.run?.status !== "ready" ||
    pendingResearch() ||
    reviewRequired()
  ) {
    toast("Resolve the incomplete study before exporting a brief.");
    return;
  }
  setBusy(true);
  $("#export-markdown").disabled = true;
  $("#export-json").disabled = true;
  const verified = await validateSession({ forExport: true });
  setBusy(false);
  showBrief();
  if (!verified) return;
  const title = (app.run.brief.title || "fieldwork-brief")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const relevantShots = Object.fromEntries(
    app.run.treatments
      .filter((treatment) => app.shots[treatment.id])
      .map((treatment) => [treatment.id, app.shots[treatment.id]]),
  );
  const selectedChecks = Object.fromEntries(
    (app.run.verification || []).map((item) => [
      item.key,
      !!app.checks[checkKey(item.key)],
    ]),
  );
  const content =
    format === "markdown"
      ? briefMarkdown()
      : JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            serverVerifiedAt: app.sessionCheckedAt,
            recoveredCreativeNotes: app.recoveredNotes,
            run: app.run,
            selectedTreatmentId: app.selected,
            editedShots: relevantShots,
            shotEditAuthor: "photographer",
            userCheckedItems: {
              candidateId: currentTreatment().candidateId,
              city: app.run.brief.city,
              items: selectedChecks,
            },
            journal: app.journal,
          },
          null,
          2,
        );
  downloadFile(content, `fieldwork-${title}.${format === "markdown" ? "md" : "json"}`, format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8");
  log(
    "Exported the working brief",
    `${format === "markdown" ? "Editable Markdown" : "Evidence JSON"} · ${currentTreatment().title}. Data provenance and limitations included.`,
  );
  persist();
  toast("Brief exported with its evidence and data labels.");
}

$("#brief-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (sessionReady() && app.run?.locks?.length && app.dirty) {
    openDialog(
      "START A FRESH STUDY",
      `<h2 id="dialog-title">A new brief,<br>a fresh shortlist.</h2><p class="dialog-lede">Re-scouting creates a fresh study from these notes. Your current kept directions will not carry into the new brief. To preserve them, change the city or a reference within the existing study.</p><div class="export-actions"><button type="button" class="button button-secondary" id="cancel-rescout">Stay with this study</button><button type="button" class="button button-accent" id="confirm-rescout">Start a fresh study ↗</button></div>`,
    );
    $("#cancel-rescout").addEventListener("click", closeDialog);
    $("#confirm-rescout").addEventListener("click", () => {
      closeDialog();
      generate();
    });
  } else generate();
});
$("#project-name").addEventListener("input", markDirty);
$("#creative-intent").addEventListener("input", markDirty);
$("#shoot-style").addEventListener("change", markDirty);
$("#apply-references").addEventListener("click", async () => {
  if (!app.run || app.busy) return;
  const changes = app.references
    .map((reference, index) => ({ reference: { ...reference }, index }))
    .filter(
      ({ reference, index }) =>
        reference.query !== app.run.brief.references[index]?.query ||
        reference.entityId !== app.run.brief.references[index]?.entityId,
    );
  if (changes.some(({ reference }) => !reference.query.trim())) {
    message("Give each reference a name before applying it.", true);
    return;
  }
  for (const change of changes) {
    const success = await revise(
      {
        type: "change-reference",
        referenceIndex: change.index,
        reference: change.reference,
      },
      "Changed a cultural reference",
    );
    if (!success) return;
  }
  toast("References updated. Revisit any kept direction marked for review.");
});
$("#city").addEventListener("change", () => {
  if (app.run && !app.busy && sessionReady()) {
    revise(
      { type: "change-city", city: $("#city").value },
      "Moved the scouting area",
    );
  } else markDirty();
});
$("#data-mode").addEventListener("change", () => {
  app.dataMode = $("#data-mode").value;
  renderConnection();
  markDirty();
  if (app.dataMode === "live" && !app.health?.qlooConfigured)
    message(
      "Qloo live is not connected yet. The sample workflow is ready to explore.",
      true,
    );
  else message("");
});
$("#references-help").addEventListener("click", () =>
  openDialog(
    "START WITH CULTURE",
    `<h2 id="dialog-title">A reference is<br>a starting point.</h2><p class="dialog-lede">Use a film, music artist and brand your client knows. Select an exact entity from the search results when a title is ambiguous.</p><section class="evidence-section"><h3>What Fieldwork asks</h3><p>Which places have a cultural-affinity connection to this combination of references? Qloo can provide that signal when a live API connection is configured.</p></section><section class="evidence-section"><h3>What you bring</h3><p>The creative reading. A place with cultural affinity is not automatically visually similar to a film. Fieldwork separates that evidence from the shot plan you write.</p></section><p class="source-note">Sample mode uses fictional places and no live affinity scores. Live mode never silently falls back to sample results.</p>`,
  ),
);
$("#open-brief-nav").addEventListener("click", showBrief);
$("#choose-brief").addEventListener("click", showExampleBriefs);
$("#close-dialog").addEventListener("click", closeDialog);
$("#detail-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
$("#detail-dialog").addEventListener("click", (event) => {
  if (event.target === $("#detail-dialog")) closeDialog();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".reference-field"))
    $$(".search-results").forEach((results) => {
      results.hidden = true;
      results.previousElementSibling?.setAttribute?.("aria-expanded", "false");
    });
});
$("#reset-session").addEventListener("click", () => {
  openDialog(
    "A CLEAN PAGE",
    `<h2 id="dialog-title">Start again?</h2><p class="dialog-lede">This clears the locally saved study, edited shots and decision journal on this device. Download the brief first if you want to keep it.</p><div class="export-actions"><button class="button button-secondary" type="button" id="cancel-reset">Keep this study</button><button class="button button-accent" type="button" id="confirm-reset">Clear the workspace</button></div>`,
  );
  $("#cancel-reset").addEventListener("click", closeDialog);
  $("#confirm-reset").addEventListener("click", () => {
    closeDialog();
    app.run = null;
    app.sessionStatus = "none";
    app.recoveredNotes = [];
    app.selected = null;
    app.shots = {};
    app.checks = {};
    app.journal = [];
    app.dirty = false;
    app.dataMode = "fixture";
    $("#data-mode").value = "fixture";
    setBrief(app.examples[0] || defaults);
    try {
      localStorage.removeItem(STORAGE);
    } catch {}
    renderEmpty();
    renderJournal();
    renderConnection();
    message("");
    $("#saved-state").textContent = "NOT YET SCOUTED";
    $("#generate-button span:first-child").textContent = "Find my direction";
    toast("A clean page, ready for a new direction.");
  });
});

async function init() {
  setBrief(defaults);
  renderEmpty();
  const responses = await Promise.allSettled([
    api("/api/health"),
    api("/api/examples"),
  ]);
  if (responses[0].status === "fulfilled") app.health = responses[0].value;
  else
    message(
      "The scouting service is not reachable. Your workspace is here; try again when the service is reachable.",
      true,
    );
  if (responses[1].status === "fulfilled")
    app.examples = responses[1].value.examples || [];
  $("#choose-brief").disabled = !app.examples.length;
  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || "null");
    if (saved?.run?.schemaVersion === "fieldwork.run.v1") {
      app.run = saved.run;
      app.sessionStatus = "checking";
      app.recoveredNotes = saved.recoveredNotes || [];
      app.selected = saved.selected;
      app.shots = saved.shots || {};
      app.checks = saved.checks || {};
      app.journal = saved.journal || [];
      app.dataMode = saved.dataMode || saved.run.dataMode || "fixture";
      setBrief(saved.brief || saved.run.brief);
      $("#data-mode").value = app.dataMode;
      renderResults();
      renderJournal();
      restored = true;
      setBusy(true);
      await validateSession();
      setBusy(false);
      if (pendingResearch()) markDirty();
    } else if (saved?.run === null && saved?.brief?.id) {
      setBrief(saved.brief);
      app.dataMode = saved.dataMode === "live" ? "live" : "fixture";
      $("#data-mode").value = app.dataMode;
      $("#saved-state").textContent = `READY TO SCOUT · ${app.dataMode === "live" ? "QLOO LIVE" : "SAMPLE"}`;
      restored = true;
    }
  } catch {
    /* Ignore incompatible or unavailable local storage. */
  }
  if (!restored) {
    if (app.examples.length) setBrief(app.examples[0]);
    app.dataMode = app.health?.defaultDataMode === "live" && app.health?.qlooConfigured ? "live" : "fixture";
    $("#data-mode").value = app.dataMode;
  }
  renderConnection();
}
init();

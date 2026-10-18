import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

async function workspace(t, { mutateSaved = () => {}, offline = false, savedWorkspace = true, healthOverride = null } = {}) {
  let time = Date.now();
  const server = createApp({ env: {}, now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${base}/api/rehearse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exampleId: 'quiet-city', dataMode: 'fixture' }) }).then(r => r.json());
  const saved = { run: structuredClone(initial), brief: structuredClone(initial.brief), shots: {}, checks: {}, journal: [], dataMode: 'fixture' };
  mutateSaved(saved);
  const nodes = new Map();
  const downloads = [];
  const blobs = new Map();
  const calls = [];
  let stored = savedWorkspace ? JSON.stringify(saved) : null;
  function element(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const node = { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, dataset: {}, isConnected: true, classList: { toggle() {}, contains() { return false; } }, addEventListener() {}, setAttribute() {}, querySelector: s => element(s), querySelectorAll: () => [], before() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; }, click() { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); } };
    nodes.set(selector, node);
    return node;
  }
  const document = { querySelector: element, querySelectorAll: () => [], createElement: tag => ({ ...element(`created-${tag}-${Math.random()}`) }), addEventListener() {}, activeElement: null };
  const context = vm.createContext({ document, localStorage: { getItem: () => stored, setItem: (_, value) => { stored = value; }, removeItem: () => { stored = null; } }, structuredClone, CSS: { escape: String }, AbortController, Blob, URL: { createObjectURL: blob => { const id = `blob:${blobs.size}`; blobs.set(id, blob); return id; }, revokeObjectURL() {} }, setTimeout: () => 1, clearTimeout() {}, console, fetch: async (url, options) => { calls.push({ url, method: options?.method || 'GET' }); if (offline) throw new Error('offline'); if (url === '/api/health' && healthOverride) return { ok:true, json:async () => healthOverride }; return fetch(base + url, options); } });
  return { initial, saved, calls, downloads, element, context, run: code => vm.runInContext(code, context), init: () => vm.runInContext(source, context), expire: () => { time += 49 * 60 * 60_000; }, stored: () => JSON.parse(stored), base };
}

test('restore replaces altered local provenance with canonical server state without spending provider calls', async t => {
  const w = await workspace(t, { mutateSaved: saved => { saved.run.dataMode = 'live'; saved.run.provenance.qlooUsed = true; saved.run.treatments[0].candidate.name = 'FORGED QLOO CLAIM'; saved.brief.title = 'My edited title'; } });
  await w.init();
  assert.equal(w.run('app.sessionStatus'), 'active');
  assert.equal(w.run('app.run.provenance.qlooUsed'), false);
  assert.notEqual(w.run('currentTreatment().candidate.name'), 'FORGED QLOO CLAIM');
  assert.equal(w.run('readBrief().title'), 'My edited title');
  assert.deepEqual(w.calls.map(c => c.url), ['/api/health', '/api/examples', `/api/briefs/${w.initial.runId}`]);
});

test('expired restore keeps edits, blocks decisions and proof export, and saves notes without evidence', async t => {
  const w = await workspace(t, { mutateSaved: saved => { saved.brief.title = 'Director notes'; saved.brief.note = 'Keep this private creative intention.'; saved.shots[saved.run.treatments[0].id] = [{ label: 'Opening', note: 'Handwritten framing note.' }]; } });
  w.expire();
  await w.init();
  assert.equal(w.run('app.sessionStatus'), 'expired');
  assert.equal(w.run('readBrief().title'), 'Director notes');
  assert.equal(w.run('shotsFor(currentTreatment())[0].note'), 'Handwritten framing note.');
  assert.match(w.element('#study-output').innerHTML, /SESSION EXPIRED/);
  const before = w.calls.length;
  assert.equal(await w.run('revise({type:"lock", targetId:currentTreatment().id})'), false);
  await w.run('exportBrief("json")');
  assert.equal(w.calls.length, before);
  assert.equal(w.downloads.length, 0);
  w.run('exportNotes()');
  const notes = await w.downloads[0].blob.text();
  assert.match(notes, /PERSONAL NOTES ONLY/);
  assert.match(notes, /Handwritten framing note/);
  assert.doesNotMatch(notes, /QLOO LIVE DATA|"qlooUsed"|"affinityRaw"/);
});

test('explicit re-scout recovers handwritten notes separately, resets keeps and practical checks', async t => {
  const w = await workspace(t, { mutateSaved: saved => { saved.brief.title = 'Recovered project'; saved.shots[saved.run.treatments[0].id] = [{ label: 'Detail', note: 'Leave space on the left.' }]; saved.checks.permission = true; } });
  w.expire();
  await w.init();
  await w.run('generate()');
  assert.equal(w.run('app.sessionStatus'), 'active');
  assert.notEqual(w.run('app.run.runId'), w.initial.runId);
  assert.equal(w.run('readBrief().title'), 'Recovered project');
  assert.equal(w.run('app.recoveredNotes[0].shots[0].note'), 'Leave space on the left.');
  assert.equal(w.run('Object.keys(app.shots).length'), 0);
  assert.equal(w.run('Object.keys(app.checks).length'), 0);
  assert.equal(w.calls.filter(c => c.url === '/api/rehearse').length, 1);
  assert.match(w.run('briefMarkdown()'), /Unassigned notes from an earlier study/);
});

test('expiry discovered on export produces no misleading file and preserves edit controls', async t => {
  const w = await workspace(t);
  await w.init();
  w.run('showBrief()');
  w.expire();
  await w.run('exportBrief("markdown")');
  assert.equal(w.run('app.sessionStatus'), 'expired');
  assert.equal(w.downloads.length, 0);
  assert.equal(w.element('#export-json').disabled, true);
  assert.match(w.element('#dialog-content').innerHTML, /Save my notes/);
});

test('expiry discovered on revision stops the decision without a new provider request', async t => {
  const w = await workspace(t);
  await w.init();
  w.expire();
  const before = w.calls.length;
  assert.equal(await w.run('revise({type:"lock", targetId:currentTreatment().id})'), false);
  assert.equal(w.run('app.sessionStatus'), 'expired');
  assert.deepEqual(w.calls.slice(before).map(c => c.url), ['/api/revise', `/api/briefs/${w.initial.runId}`]);
});

test('unreachable server preserves a local workspace without treating it as live proof', async t => {
  const w = await workspace(t, { offline: true });
  await w.init();
  assert.equal(w.run('app.sessionStatus'), 'unavailable');
  assert.equal(w.run('pauseEvidence()'), true);
  assert.match(w.element('#dialog-content').innerHTML, /Evidence needs/);
  assert.equal(w.downloads.length, 0);
});

test('export checks server revision, then requires review before downloading a newer version', async t => {
  const w = await workspace(t);
  await w.init();
  await fetch(`${w.base}/api/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: { runId: w.initial.runId, revision: 1 }, action: { type: 'lock', targetId: w.initial.treatments[0].id } }) });
  w.run('showBrief()');
  await w.run('exportBrief("json")');
  assert.equal(w.run('app.run.revision'), 2);
  assert.equal(w.downloads.length, 0);
  await w.run('exportBrief("json")');
  assert.equal(w.downloads.length, 1);
  const exported = JSON.parse(await w.downloads[0].blob.text());
  assert.equal(exported.run.revision, 2);
  assert.ok(exported.serverVerifiedAt);
});

test('model-proposed titles, premises and shot notes remain text in the interface', async t => {
  const w = await workspace(t);
  await w.init();
  w.run(`currentTreatment().title = '<img src=x onerror=alert(1)>';
    currentTreatment().editorial.source = 'model-proposed';
    currentTreatment().editorial.premise = '<script>alert(1)</script>';
    currentTreatment().editorial.shots[0].note = '</textarea><script>alert(1)</script>';
    renderResults();`);
  const results = w.element('#study-output').innerHTML;
  assert.match(results, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(results, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(results, /Creative proposal · AI-assisted/);
  assert.match(results, /Ideas to test on a scout\. Lighting, layout and access have not been verified\./);
  assert.doesNotMatch(results, /<img src=x|<script>alert/);
  w.run('showBrief()');
  assert.match(w.element('#dialog-content').innerHTML, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.match(w.element('#dialog-content').innerHTML, /Ideas to test on a scout\. Lighting, layout and access have not been verified\./);
  assert.match(w.run('briefMarkdown()'), /No claim is made about availability, permission, fees, opening hours, weather, lighting or individual preference/);
  assert.doesNotMatch(w.element('#dialog-content').innerHTML, /<script>alert/);
});

test('a changed research context requires a re-scout; cloud disclosure identifies actual routing', async t => {
  const w = await workspace(t);
  await w.init();
  w.element('#city').value = 'Lisbon';
  const before = w.calls.length;
  await w.run('exportBrief("json")');
  assert.equal(w.calls.length, before);
  assert.equal(w.downloads.length, 0);
  w.run(`app.health = { qlooConfigured:true, planner:'groq', plannerConfigured:true }; app.dataMode='live'; renderConnection();`);
  assert.match(w.element('#data-use-note').textContent, /references and city to Qloo/);
  assert.match(w.element('#data-use-note').textContent, /candidate places go to Groq/);
  assert.match(w.run('plannerLabel({planner:"groq-with-policy-fallback"})'), /explicit policy fallback/);
});


test('a configured live default prepares a new workspace without making provider calls', async t => {
  const w = await workspace(t, { savedWorkspace:false, healthOverride:{ qlooConfigured:true, defaultDataMode:'live', planner:'groq', plannerConfigured:true } });
  await w.init();
  assert.equal(w.run('app.dataMode'), 'live');
  assert.equal(w.run('app.run'), null);
  assert.equal(w.element('#data-mode').value, 'live');
  assert.deepEqual(w.calls.map(c => c.url), ['/api/health', '/api/examples']);
});

test('an unconfigured live default stays in sample; a saved unfinished live draft keeps its intent', async t => {
  const w = await workspace(t, { savedWorkspace:false, healthOverride:{ qlooConfigured:false, defaultDataMode:'live' } });
  await w.init();
  assert.equal(w.run('app.dataMode'), 'fixture');
  const draft = await workspace(t, { mutateSaved:saved => { saved.run = null; saved.dataMode = 'live'; saved.brief.title = 'My unfinished live study'; } });
  await draft.init();
  assert.equal(draft.run('app.dataMode'), 'live');
  assert.equal(draft.run('readBrief().title'), 'My unfinished live study');
  assert.deepEqual(draft.calls.map(c => c.url), ['/api/health', '/api/examples']);
});

test('a treatment retired in another tab keeps handwritten notes visible and exportable after canonical refresh', async t => {
  const w = await workspace(t);
  await w.init();
  const retiredId = w.initial.treatments[0].id;
  const survivorId = w.initial.treatments[1].id;
  w.run(`app.selected = ${JSON.stringify(retiredId)};
    app.shots[${JSON.stringify(retiredId)}] = [{ label:'Opening gesture', note:'Let the subject choose the last frame.' }];
    app.shots[${JSON.stringify(survivorId)}] = [{ label:'Counterpoint', note:'Leave room for the cover title.' }];`);
  const response = await fetch(`${w.base}/api/revise`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ state:{ runId:w.initial.runId, revision:w.initial.revision }, action:{ type:'veto', targetId:w.initial.treatments[0].candidateId, reason:'Unavailable for the shoot.' } }) });
  assert.equal(response.status, 200);
  await w.run('validateSession()');
  assert.equal(w.run('app.recoveredNotes.length'), 1);
  assert.equal(w.run('app.recoveredNotes[0].shots[0].note'), 'Let the subject choose the last frame.');
  assert.equal(w.run(`app.shots[${JSON.stringify(retiredId)}]`), undefined);
  assert.equal(w.run(`app.shots[${JSON.stringify(survivorId)}][0].note`), 'Leave room for the cover title.');
  assert.notEqual(w.run('app.selected'), retiredId);
  assert.equal(w.run('app.run.treatments.some(item => item.id === app.selected)'), true);
  w.run('showBrief()');
  assert.match(w.element('#dialog-content').innerHTML, /Let the subject choose the last frame/);
  assert.match(w.run('briefMarkdown()'), /Unassigned notes from an earlier study[\s\S]*Let the subject choose the last frame/);
  await w.run('validateSession()');
  await w.run('exportBrief("json")');
  const exported = JSON.parse(await w.downloads[0].blob.text());
  assert.equal(exported.recoveredCreativeNotes.length, 1);
  assert.equal(exported.recoveredCreativeNotes[0].shots[0].note, 'Let the subject choose the last frame.');
  assert.equal(w.stored().recoveredNotes.length, 1);
});

test('restoring an older snapshot does not duplicate notes already recovered from its retired direction', async t => {
  const w = await workspace(t, { mutateSaved:saved => {
    const direction = saved.run.treatments[0];
    const shots = [{ label:'Closing frame', note:'Save the final gesture for the last image.' }];
    saved.shots[direction.id] = structuredClone(shots);
    saved.recoveredNotes = [{ previousDirection:direction.title, previousLocation:direction.candidate.name, shots }];
  } });
  const response = await fetch(`${w.base}/api/revise`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ state:{ runId:w.initial.runId, revision:w.initial.revision }, action:{ type:'veto', targetId:w.initial.treatments[0].candidateId, reason:'Unavailable for the shoot.' } }) });
  assert.equal(response.status, 200);
  await w.init();
  assert.equal(w.run('app.recoveredNotes.length'), 1);
  assert.equal(w.run('app.recoveredNotes[0].shots[0].note'), 'Save the final gesture for the last image.');
  assert.equal(w.stored().recoveredNotes.length, 1);
});

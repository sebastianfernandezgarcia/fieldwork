import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearse, revise, compareCandidates } from '../lib/engine.mjs';
import { FixtureProvider } from '../lib/fixtures.mjs';
import { createOllamaPlanner } from '../lib/planner.mjs';

test('sample brief completes two different editable directions without claiming Qloo results', async () => {
  const state = await rehearse({ exampleId: 'quiet-city' });
  assert.equal(state.status, 'ready');
  assert.equal(state.treatments.length, 2);
  assert.notEqual(state.treatments[0].candidate.kind, state.treatments[1].candidate.kind);
  assert.deepEqual(state.treatments.map(t => t.editorial.direction), ['quiet', 'graphic']);
  assert.ok(state.candidates.every(c => c.source === 'fixture' && c.affinityRaw === null));
  assert.equal(state.provenance.qlooUsed, false);
  assert.equal(state.comparison.available, false);
  assert.equal(state.verification.find(v => v.key === 'permission').status, 'unverified');
});

test('locking the second treatment preserves its slot and content when the first is rejected', async () => {
  let state = await rehearse({ exampleId: 'quiet-city' });
  const rejected = state.treatments[0].candidateId;
  const fixedId = state.treatments[1].id;
  state = await revise(state, { type: 'lock', targetId: fixedId });
  const fixed = structuredClone(state.treatments[1]);
  state = await revise(state, { type: 'veto', targetId: rejected, reason: 'The client wants a more open setting.' });
  assert.deepEqual(state.treatments[1], fixed);
  assert.equal(state.treatments[0].editorial.direction, 'quiet');
  assert.equal(state.treatments[1].editorial.direction, 'graphic');
  assert.ok(!state.candidates.some(c => c.id === rejected));
  assert.ok(!state.treatments.some(t => t.candidateId === rejected));
  assert.equal(state.revision, 3);
});

test('a locked treatment cannot be vetoed and the previous revision remains untouched', async () => {
  let state = await rehearse({ exampleId: 'quiet-city' });
  state = await revise(state, { type: 'lock', targetId: state.treatments[0].id });
  const before = structuredClone(state);
  await assert.rejects(revise(state, { type: 'veto', targetId: state.treatments[0].id }), { code: 'LOCKED_TREATMENT' });
  assert.deepEqual(state, before);
});

test('a rejected alternative is excluded even when it was not a selected treatment', async () => {
  let state = await rehearse({ exampleId: 'quiet-city' });
  const alternative = state.candidates.find(c => !state.treatments.some(t => t.candidateId === c.id));
  state = await revise(state, { type: 'veto', targetId: alternative.id, reason: 'Ruled out during the scout.' });
  assert.ok(state.brief.avoidEntityIds.includes(alternative.id));
  assert.ok(!state.candidates.some(c => c.id === alternative.id));
});

test('a new cultural reference marks fixed decisions for review and reruns evidence', async () => {
  let state = await rehearse({ exampleId: 'quiet-city' });
  state = await revise(state, { type: 'lock', targetId: state.treatments[0].id });
  const fixedId = state.treatments[0].id;
  state = await revise(state, { type: 'change-reference', referenceIndex: 0, reference: { query: 'Paterson', domain: 'movie' } });
  assert.equal(state.treatments.find(t => t.id === fixedId).needsReview, true);
  assert.equal(state.resolvedReferences[0].name, 'Paterson');
  assert.ok(state.trace.some(t => t.revision === 3 && t.tool === 'discover_places'));
});

test('changing city never presents a locked location as freshly verified', async () => {
  let state = await rehearse({ exampleId: 'quiet-city' });
  state = await revise(state, { type: 'lock', targetId: state.treatments[1].id });
  const oldId = state.treatments[1].candidateId;
  state = await revise(state, { type: 'change-city', city: 'London' });
  assert.equal(state.treatments[1].candidateId, oldId);
  assert.equal(state.treatments[1].needsReview, true);
  assert.ok(state.warnings.some(w => w.includes('previous search')));
  assert.ok(state.candidates.every(c => c.id.includes('london')));
  state = await revise(state, { type: 'veto', targetId: state.treatments[0].id });
  assert.ok(state.warnings.some(w => w.includes('previous search')));
  state = await revise(state, { type: 'unlock', targetId: oldId });
  state = await revise(state, { type: 'veto', targetId: oldId });
  assert.ok(state.treatments.every(t => t.candidate.city === 'London'));
  assert.ok(!state.warnings.some(w => w.includes('previous search')));
});

test('ambiguous titles pause and can be resolved by an actual returned entity ID', async () => {
  let state = await rehearse({ brief: { city: 'Barcelona', references: [{ query: 'Dune', domain: 'movie' }] } });
  assert.equal(state.status, 'needs_input');
  assert.equal(state.resolutionIssues[0].candidates.length, 2);
  assert.equal(state.treatments.length, 0);
  const selected = state.resolutionIssues[0].candidates[1];
  state = await revise(state, { type: 'change-reference', referenceIndex: 0, reference: { query: 'Dune', domain: 'movie', entityId: selected.id } });
  assert.equal(state.status, 'ready');
  assert.equal(state.resolvedReferences[0].disambiguation, '1984, David Lynch');
});

test('unsupported or forged reference identity is never accepted', async () => {
  const state = await rehearse({ brief: { city: 'Madrid', references: [{ query: 'Amélie', domain: 'movie', entityId: 'fake-id' }] } });
  assert.equal(state.status, 'needs_input');
  assert.equal(state.resolvedReferences.length, 0);
});

test('a changed ambiguous reference clears old suggestions while preserving locked history as needing review', async () => {
  let state = await rehearse({ exampleId: 'quiet-city' });
  state = await revise(state, { type: 'lock', targetId: state.treatments[1].id });
  const fixedId = state.treatments[1].id;
  state = await revise(state, { type: 'change-reference', referenceIndex: 0, reference: { query: 'Dune', domain: 'movie' } });
  assert.equal(state.status, 'needs_input');
  assert.deepEqual(state.candidates, []);
  assert.equal(state.comparison, null);
  assert.equal(state.treatments.length, 1);
  assert.equal(state.treatments[0].id, fixedId);
  assert.equal(state.treatments[0].needsReview, true);
  assert.ok(state.treatments[0].evidence.referenceNames.includes('In the Mood for Love'));
});

test('validated photographer edits survive a canonical revision without accepting evidence fields', async () => {
  const state = await rehearse({ exampleId: 'quiet-city' });
  const revised = await revise(state, { type: 'lock', targetId: state.treatments[0].id }, { briefEdits: { title: 'The new title', note: 'Make a wider frame.' } });
  assert.equal(revised.brief.title, 'The new title');
  assert.equal(revised.brief.note, 'Make a wider frame.');
  await assert.rejects(revise(state, { type: 'lock', targetId: state.treatments[0].id }, { briefEdits: { references: [] } }), { code: 'VALIDATION' });
});

test('insufficient coverage changes the tool plan and relaxes only the soft category', async () => {
  const provider = new FixtureProvider();
  const original = provider.discover.bind(provider);
  provider.discover = async args => args.tags.length ? [] : original(args);
  const state = await rehearse({ exampleId: 'quiet-city' }, { provider });
  assert.equal(state.status, 'ready');
  assert.ok(state.trace.some(t => t.tool === 'relax_preferences'));
  assert.equal(state.brief.city, 'Barcelona');
  assert.equal(state.resolvedReferences.length, 3);
});

test('even after relaxation zero coverage is explicit and no venue is invented', async () => {
  const provider = new FixtureProvider();
  provider.discover = async () => [];
  const state = await rehearse({ exampleId: 'quiet-city' }, { provider });
  assert.equal(state.status, 'insufficient');
  assert.deepEqual(state.treatments, []);
});

test('baseline compares the same live candidates without turning scores into probabilities', () => {
  const candidates = [{ id: 'a', name: 'A', affinityRaw: 0.7, popularityRaw: 0.2 }, { id: 'b', name: 'B', affinityRaw: 0.3, popularityRaw: 0.9 }];
  const comparison = compareCandidates(candidates, 'live');
  assert.equal(comparison.available, true);
  assert.deepEqual(comparison.tasteOrder, ['a', 'b']);
  assert.deepEqual(comparison.popularityOrder, ['b', 'a']);
  assert.deepEqual(candidates.map(c => c.affinityRaw), [0.7, 0.3]);
  assert.match(comparison.note, /does not prove/);
});

test('a failed local model is reported as actual policy execution, not local LLM execution', async () => {
  const planner = createOllamaPlanner({ fetchImpl: async () => { throw new Error('offline'); } });
  const state = await rehearse({ exampleId: 'quiet-city' }, { planner });
  assert.equal(state.provenance.planner, 'bounded-policy-v1');
  assert.equal(state.provenance.configuredPlanner, 'local-ollama');
  assert.equal(state.provenance.modelActions, 0);
  assert.equal(state.provenance.model, null);
  assert.ok(state.warnings.some(w => w.includes('explicit bounded policy')));
});

test('local planner receives observed candidates and a validated choice changes selected treatments', async () => {
  let observed = [];
  const planner = createOllamaPlanner({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const context = JSON.parse(request.messages[1].content);
    observed.push(context);
    const decision = context.availableTools.includes('discover_places') ? { action: 'discover_places', usePreferences: false } : { action: 'select_treatments', candidateIds: context.candidates.slice(-2).map(c => c.id) };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(decision) } }), { headers: { 'content-type': 'application/json' } });
  } });
  const state = await rehearse({ exampleId: 'quiet-city' }, { planner });
  assert.equal(observed[0].candidates.length, 0);
  assert.ok(observed[1].candidates.length > 2);
  assert.deepEqual(state.treatments.map(t => t.candidateId), observed[1].candidates.slice(-2).map(c => c.id));
  assert.equal(state.provenance.planner, 'local-ollama');
  assert.equal(state.provenance.modelActions, 2);
});

test('an invented model-selected candidate falls back visibly instead of entering the brief', async () => {
  const planner = createOllamaPlanner({ fetchImpl: async (_url, options) => {
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    const decision = context.availableTools.includes('discover_places') ? { action: 'discover_places', usePreferences: false } : { action: 'select_treatments', candidateIds: ['invented-one', 'invented-two'] };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(decision) } }));
  } });
  const state = await rehearse({ exampleId: 'quiet-city' }, { planner });
  assert.ok(state.treatments.every(t => !t.candidateId.includes('invented')));
  assert.equal(state.provenance.planner, 'local-ollama-with-policy-fallback');
});

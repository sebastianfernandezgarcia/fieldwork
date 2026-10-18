import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroqPlanner, DEFAULT_GROQ_MODEL } from '../lib/planner.mjs';
import { rehearse, revise } from '../lib/engine.mjs';
import { FIXTURE_NOTE } from '../lib/fixtures.mjs';

// Controlled model responses exercise the contract, not model quality or a
// live provider. Candidate identities still come from the fixture tool loop.
function proposalPlanner(mutate = value => value) {
  return createGroqPlanner({ apiKey: 'test-only-proposal-credential', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const observation = JSON.parse(request.messages[1].content);
    const discovering = observation.availableTools.includes('discover_places');
    const candidateIds = discovering ? [] : [...observation.lockedCandidateIds, ...observation.candidates.map(c => c.id).filter(id => !observation.lockedCandidateIds.includes(id))].slice(0, 2);
    const creativeProposals = candidateIds.filter(id => !observation.lockedCandidateIds.includes(id)).map((candidateId, index) => ({
      candidateId,
      title: `${index ? 'Gesture' : 'Pause'}: ${observation.brief.references[0].query}`,
      tagline: `Try a ${index ? 'moving' : 'still'} portrait sequence.`,
      premise: `Explore the brief “${observation.brief.title}” as a ${index ? 'sequence of gestures' : 'held moment'}. Test this idea during the scout.`,
      shots: [
        { label: '01 / Establish', note: `Try a wide composition for ${observation.brief.city}. Ask the subject to choose a comfortable gesture.` },
        { label: '02 / Change', note: `Propose a ${index ? 'moving' : 'still'} counterpart, keeping the same gesture as a thread.` },
        { label: '03 / Resolve', note: 'Finish with a close portrait, then review the sequence with the subject.' }
      ]
    }));
    const action = discovering ? { action: 'discover_places', usePreferences: true } : { action: 'select_treatments', candidateIds, creativeProposals: mutate(creativeProposals) };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }] }));
  } });
}

test('brief-specific creative proposals reach the treatment while evidence and fixed editorial survive revision', async () => {
  let first = await rehearse({ exampleId: 'quiet-city' }, { planner: proposalPlanner() });
  const second = await rehearse({ exampleId: 'slow-city' }, { planner: proposalPlanner() });
  assert.notEqual(first.treatments[0].title, second.treatments[0].title);
  assert.ok(first.treatments[0].title.includes(first.brief.references[0].query));
  assert.ok(second.treatments[0].editorial.premise.includes(second.brief.title));
  for (const state of [first, second]) {
    assert.equal(state.provenance.modelActions, 2);
    assert.equal(state.provenance.plannerCalls, 2);
    assert.equal(state.provenance.qlooUsed, false);
    for (const treatment of state.treatments) {
      assert.equal(treatment.editorial.source, 'model-proposed');
      assert.equal(treatment.editorial.provider, 'groq');
      assert.equal(treatment.editorial.model, DEFAULT_GROQ_MODEL);
      assert.equal(treatment.editorial.shots.length, 3);
      assert.match(treatment.editorial.note, /not an observation/);
      assert.equal(treatment.editorial.validation.policy, 'proposal-action-form-v1');
      assert.equal(treatment.editorial.validation.factualVerification, false);
      assert.equal(treatment.evidence.source, 'fixture');
      assert.equal(treatment.evidence.affinityRaw, treatment.candidate.affinityRaw);
    }
  }
  const fixedId = first.treatments[1].id;
  first = await revise(first, { type: 'lock', targetId: fixedId });
  const fixed = structuredClone(first.treatments[1]);
  const revised = await revise(first, { type: 'veto', targetId: first.treatments[0].id }, { planner: proposalPlanner() });
  assert.deepEqual(revised.treatments[1], fixed);
  assert.equal(revised.treatments[0].editorial.source, 'model-proposed');
  assert.notEqual(revised.treatments[0].candidateId, first.treatments[0].candidateId);
});

test('observed venue assertions are rejected even after an initial action sentence', async t => {
  const observedFailure = 'In the muted light of the Still Gallery, the subject’s silhouette is framed against a pale wall, echoing the calm yet bold tone of a debut release. The setting invites movement within a restrained space, allowing the portrait to feel both intimate and expansive.';
  for (const [name, mutate] of Object.entries({
    'observed real failure': proposals => [{ ...proposals[0], premise: observedFailure }, proposals[1]],
    'statement after action': proposals => [{ ...proposals[0], premise: 'Try a silhouette study. The venue has soft daylight and pale walls.' }, proposals[1]],
    'descriptive shot note': proposals => [{ ...proposals[0], shots: proposals[0].shots.map((shot, index) => index ? shot : { ...shot, note: 'The courtyard gives the portrait natural shade.' }) }, proposals[1]]
  })) await t.test(name, async () => {
    const state = await rehearse({ exampleId: 'quiet-city' }, { planner: proposalPlanner(mutate) });
    assert.equal(state.status, 'ready');
    assert.equal(state.provenance.planner, 'groq');
    assert.ok(state.treatments.every(t => t.editorial.source === 'authored-template' && t.editorial.fallbackReason.includes('proposed actions')));
    assert.ok(state.treatments.every(t => t.editorial.fallbackCode === 'CREATIVE_ACTION_FORM'));
    assert.ok(!JSON.stringify(state.treatments).includes('muted light'));
  });
});

test('Position introduces a valid proposed shooting action', async () => {
  const state = await rehearse({ exampleId: 'quiet-city' }, {
    planner: proposalPlanner(proposals => proposals.map(proposal => ({
      ...proposal,
      shots: proposal.shots.map((shot, index) => index ? shot : { ...shot, note: 'Position the subject at a comfortable distance and test a wider frame during the scout.' })
    })))
  });
  assert.ok(state.treatments.every(t => t.editorial.source === 'model-proposed'));
  assert.ok(state.treatments.every(t => t.editorial.shots[0].note.startsWith('Position the subject')));
  assert.ok(state.treatments.every(t => t.editorial.validation.factualVerification === false));
});

test('an observed extra proposal for a locked candidate cannot rewrite the accepted treatment', async () => {
  const first = await rehearse({ exampleId: 'quiet-city' }, { planner: proposalPlanner() });
  const locked = await revise(first, { type: 'lock', targetId: first.treatments[0].id });
  const fixed = structuredClone(locked.treatments[0]);
  const revised = await revise(locked, { type: 'veto', targetId: locked.treatments[1].id }, {
    planner: proposalPlanner(proposals => [{ ...proposals[0], candidateId: fixed.candidateId, title: 'Unrequested rewrite' }, ...proposals])
  });
  assert.deepEqual(revised.treatments[0], fixed);
  assert.equal(revised.provenance.planner, 'groq');
  assert.equal(revised.treatments[1].editorial.source, 'authored-template');
  assert.equal(revised.treatments[1].editorial.fallbackCode, 'CREATIVE_PROPOSAL_COUNT');
  assert.equal(revised.trace.at(-1).creativeFailureCode, 'CREATIVE_PROPOSAL_COUNT');
  assert.notEqual(revised.treatments[1].candidateId, locked.treatments[1].candidateId);
  assert.ok(!JSON.stringify(revised.treatments).includes('Unrequested rewrite'));
});

test('the observed 102-character tagline is rejected without changing a fixed treatment or relaxing the 100-character limit', async () => {
  const first = await rehearse({ exampleId: 'quiet-city' }, { planner: proposalPlanner() });
  const locked = await revise(first, { type: 'lock', targetId: first.treatments[0].id });
  const fixed = structuredClone(locked.treatments[0]);
  for (const length of [100, 102]) {
    const tagline = 'A'.repeat(length);
    const revised = await revise(locked, { type: 'veto', targetId: locked.treatments[1].id }, {
      planner: proposalPlanner(proposals => proposals.map(proposal => ({ ...proposal, tagline })))
    });
    assert.deepEqual(revised.treatments[0], fixed);
    assert.equal(revised.provenance.planner, 'groq');
    assert.equal(revised.provenance.policyActions, 0);
    const replacement = revised.treatments[1];
    assert.notEqual(replacement.candidateId, locked.treatments[1].candidateId);
    if (length === 100) {
      assert.equal(replacement.editorial.source, 'model-proposed');
      assert.equal(replacement.tagline, tagline);
      assert.equal(replacement.editorial.fallbackCode, undefined);
    } else {
      assert.equal(replacement.editorial.source, 'authored-template');
      assert.equal(replacement.editorial.fallbackCode, 'CREATIVE_TEXT_LIMIT');
      assert.equal(revised.trace.at(-1).creativeFailureCode, 'CREATIVE_TEXT_LIMIT');
      assert.notEqual(replacement.tagline, tagline.slice(0, 100));
    }
  }
});

test('a successful new scout clears stale provider warnings while preserving fixture limits and failure history', async () => {
  const failed = await rehearse({ exampleId: 'quiet-city' }, {
    planner: createGroqPlanner({ apiKey: 'test-only-credential', fetchImpl: async () => new Response('', { status: 503 }) })
  });
  assert.ok(failed.warnings.some(w => w.includes('explicit bounded policy')));
  const locked = await revise(failed, { type: 'lock', targetId: failed.treatments[0].id });
  assert.deepEqual(locked.warnings, failed.warnings);
  const revised = await revise(locked, { type: 'veto', targetId: locked.treatments[1].id }, { planner: proposalPlanner() });
  assert.equal(revised.provenance.planner, 'groq');
  assert.equal(revised.provenance.policyActions, 0);
  assert.deepEqual(revised.warnings, [FIXTURE_NOTE]);
  assert.deepEqual(revised.treatments[0], locked.treatments[0]);
  assert.deepEqual(revised.trace.filter(t => t.revision === failed.revision), failed.trace);
  assert.ok(revised.trace.some(t => t.fallbackCode === 'GROQ_UPSTREAM'));
  assert.ok(failed.warnings.some(w => w.includes('explicit bounded policy')));
});

test('a retained editorial fallback stays visible after successful research of the other direction', async () => {
  const failed = await rehearse({ exampleId: 'quiet-city' }, { planner: proposalPlanner(proposals => proposals.map(p => ({ ...p, premise: 'The venue has pale walls.' }))) });
  const locked = await revise(failed, { type: 'lock', targetId: failed.treatments[0].id });
  const revised = await revise(locked, { type: 'veto', targetId: locked.treatments[1].id }, { planner: proposalPlanner() });
  assert.equal(revised.treatments[0].editorial.fallbackCode, 'CREATIVE_ACTION_FORM');
  assert.equal(revised.treatments[1].editorial.source, 'model-proposed');
  assert.ok(revised.warnings.includes(FIXTURE_NOTE));
  assert.ok(revised.warnings.some(w => w.includes('fixed treatment retains authored text')));
  assert.ok(!revised.warnings.some(w => w.includes('Authored templates were used for the new directions')));
  assert.ok(revised.trace.some(t => t.revision === failed.revision && t.creativeFailureCode === 'CREATIVE_ACTION_FORM'));
});

test('invalid creative binding or injected evidence keeps valid locations and visibly falls back to authored text', async t => {
  const mutations = {
    'unknown candidate': proposals => [{ ...proposals[0], candidateId: 'not-returned-by-qloo' }, proposals[1]],
    'duplicate candidate': proposals => [proposals[0], proposals[0]],
    'injected evidence': proposals => [{ ...proposals[0], evidence: { source: 'qloo', affinityRaw: 1 } }, proposals[1]],
    'unbounded text': proposals => [{ ...proposals[0], premise: 'x'.repeat(321) }, proposals[1]],
    'incomplete shot plan': proposals => [{ ...proposals[0], shots: [] }, proposals[1]]
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const state = await rehearse({ exampleId: 'quiet-city' }, { planner: proposalPlanner(mutate) });
    assert.equal(state.status, 'ready');
    assert.equal(state.provenance.planner, 'groq');
    assert.equal(state.provenance.qlooUsed, false);
    assert.ok(state.treatments.every(t => t.editorial.source === 'authored-template' && t.editorial.fallbackReason));
    assert.ok(state.warnings.some(w => w.includes('creative proposals were missing or invalid')));
    assert.ok(state.treatments.every(t => state.candidates.some(c => c.id === t.candidateId)));
    assert.ok(state.treatments.every(t => t.evidence.source === 'fixture'));
    assert.equal(JSON.stringify(state).includes('not-returned-by-qloo'), false);
  });
});

test('policy runs keep the authored treatment without falsely claiming a model proposal', async () => {
  const state = await rehearse({ exampleId: 'quiet-city' });
  assert.ok(state.treatments.every(t => t.editorial.source === 'authored-template'));
  assert.ok(state.treatments.every(t => t.editorial.model === undefined && t.editorial.fallbackReason === undefined));
});

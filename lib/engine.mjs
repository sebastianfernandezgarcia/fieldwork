import { randomUUID, createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
import { FixtureProvider, FIXTURE_NOTE, EXAMPLES } from './fixtures.mjs';
import { QlooProvider } from './qloo.mjs';
import { createPolicyPlanner } from './planner.mjs';
import { validateBrief, validateMode, validateReference, normalize, text } from './validation.mjs';

const CHECKS = [
  { key: 'access', label: 'Access and availability', status: 'unverified', note: 'Confirm whether the location can host this session.' },
  { key: 'permission', label: 'Photography permission', status: 'unverified', note: 'Ask the owner or relevant authority before the shoot.' },
  { key: 'openingHours', label: 'Opening hours', status: 'unverified', note: 'Check the intended date directly with the location.' },
  { key: 'price', label: 'Fees and costs', status: 'unverified', note: 'No fee, rental or admission price has been verified.' },
  { key: 'weather', label: 'Light and weather', status: 'unverified', note: 'Scout the actual light and check conditions before shooting.' }
];

const DIRECTIONS = {
  quiet: {
    title: 'The quiet frame', tagline: 'A close portrait. Space for a small gesture.',
    premise: 'Try a restrained portrait sequence: one frame that gives the subject room, then move closer. This is an editorial proposal to test on the scout, not a description of verified light at the location.',
    shots: [
      { label: '01 / A sense of place', note: 'Find a clean frame that includes the subject and one meaningful detail of the setting.' },
      { label: '02 / The pause', note: 'Move in for a portrait between gestures. Keep one frame still and one in motion.' },
      { label: '03 / A small detail', note: 'Ask the subject to choose an object or gesture. Photograph it with permission.' }
    ], palette: ['#d8ccba', '#33443c', '#9b5745']
  },
  graphic: {
    title: 'The graphic frame', tagline: 'A wider gesture. A stronger line.',
    premise: 'Explore a more graphic treatment: let a line or repeated shape organise the frame, then interrupt it with the subject. Confirm the space and conditions during the scout before committing.',
    shots: [
      { label: '01 / Draw the frame', note: 'Look for a usable line or repeated shape. Keep the subject small in the first composition.' },
      { label: '02 / Break the rhythm', note: 'Ask for one movement across the frame. Make a still counterpart so the editor has a choice.' },
      { label: '03 / The cover image', note: 'Finish with a direct portrait and leave deliberate room for a title or crop.' }
    ], palette: ['#c9cabf', '#202c31', '#b3492c']
  }
};

export function providerFor(mode, config = {}) {
  return mode === 'fixture' ? new FixtureProvider() : new QlooProvider(config);
}

export function exampleById(id) {
  const example = EXAMPLES.find(e => e.id === id);
  if (!example) throw new AppError('VALIDATION', 'Choose an existing sample brief.');
  return structuredClone(example);
}

function createState(brief, dataMode) {
  return {
    schemaVersion: 'fieldwork.run.v1', runId: randomUUID(), revision: 1, dataMode, status: 'draft', brief,
    resolvedReferences: [], resolutionIssues: [], treatments: [], candidates: [], locks: [], decisions: [], trace: [], comparison: null,
    verification: structuredClone(CHECKS), warnings: dataMode === 'fixture' ? [FIXTURE_NOTE] : [],
    provenance: { planner: 'bounded-policy-v1', model: null, plannerCalls: 0, qlooUsed: false, fixtureNote: dataMode === 'fixture' ? FIXTURE_NOTE : null, retrievedAt: new Date().toISOString(), requestCount: 0 }
  };
}

function event(state, tool, inputSummary, outputSummary, candidateIds = [], status = 'completed', extra = {}) {
  state.trace.push({ id: randomUUID(), step: (state.trace.at(-1)?.step ?? 0) + 1, revision: state.revision, tool, status, inputSummary, outputSummary, candidateIds, ...extra });
  if (state.trace.length > 100) state.trace = state.trace.slice(-100);
}

export async function resolveReferences(state, provider) {
  const resolved = [];
  const issues = [];
  for (const [index, reference] of state.brief.references.entries()) {
    const started = performance.now();
    const results = await provider.search(reference.query, reference.domain);
    const exact = results.filter(r => normalize(r.name) === normalize(reference.query));
    const chosen = reference.entityId ? results.find(r => r.id === reference.entityId) : exact.length === 1 ? exact[0] : null;
    if (chosen) {
      resolved.push(chosen);
      event(state, 'resolve_reference', `${reference.query} · ${reference.domain}`, `Resolved ${chosen.name}${chosen.disambiguation ? ` (${chosen.disambiguation})` : ''}.`, [chosen.id], 'completed', { durationMs: Math.round(performance.now() - started) });
    } else {
      issues.push({ index, query: reference.query, reason: results.length ? 'Choose the intended cultural reference before continuing.' : 'No matching reference was found. Try another name.', candidates: results });
      event(state, 'resolve_reference', `${reference.query} · ${reference.domain}`, results.length ? 'Reference needs a choice.' : 'Reference not found.', results.map(r => r.id), 'needs_input');
    }
  }
  state.resolvedReferences = resolved;
  state.resolutionIssues = issues;
  return issues.length === 0;
}

function treatment(candidate, slot, references, proposal, model, proposalFallback = false) {
  const directionName = slot === 0 ? 'quiet' : 'graphic';
  const direction = structuredClone(DIRECTIONS[directionName]);
  const { title, tagline, ...editorial } = direction;
  return {
    id: `treatment:${candidate.id}`, title: proposal?.title ?? title, tagline: proposal?.tagline ?? tagline, slot, candidateId: candidate.id, candidate,
    locked: false, needsReview: false,
    editorial: proposal ? {
      source: 'model-proposed', provider: 'groq', model, direction: 'tailored', premise: proposal.premise, shots: proposal.shots, palette: editorial.palette,
      note: 'A model-proposed creative exercise based on the brief and cultural references. It is not an observation of this venue or Qloo evidence. Verify feasibility on a scout.',
      validation: { policy: 'proposal-action-form-v1', actionFormChecked: true, factualVerification: false },
      limitations: 'The text was checked for proposed-action form, not factual truth. Generated ideas may still contain assumptions; verify feasibility, lighting, layout and access on a scout.'
    } : { source: 'authored-template', direction: directionName, ...editorial, ...(proposalFallback ? { fallbackCode: proposalFallback, fallbackReason: 'The model-selected location was retained, but its creative proposal was missing, invalid or not written as proposed actions.' } : {}) },
    evidence: {
      source: candidate.source, affinityRaw: candidate.affinityRaw, rank: candidate.rank, explanation: candidate.explanation,
      referenceNames: references.map(r => r.name),
      note: candidate.source === 'fixture' ? FIXTURE_NOTE : 'Qloo returned this place for the combined references. Aggregate affinity is not visual similarity or a personal probability.'
    }
  };
}

const PROPOSAL_ACTIONS = new Set(['try', 'propose', 'explore', 'ask', 'invite', 'test', 'frame', 'photograph', 'compare', 'keep', 'leave', 'finish', 'confirm', 'plan', 'position']);
const sentenceSegments = new Intl.Segmenter('en', { granularity: 'sentence' });

function proposedAction(value, name, max) {
  const result = text(value, name, max);
  // This is a narrow language-form gate, not a factuality classifier. Reject
  // descriptive sentences instead of presenting them as observed venue facts.
  for (const { segment } of sentenceSegments.segment(result)) {
    const firstWord = segment.trim().match(/^[a-z]+/i)?.[0]?.toLowerCase();
    if (!PROPOSAL_ACTIONS.has(firstWord)) throw new AppError('CREATIVE_ACTION_FORM', 'Creative text must propose an action.');
  }
  return result;
}

function creativeProposals(value, expectedIds) {
  try {
    if (!Array.isArray(value) || value.length !== expectedIds.length || value.length > 2) return { proposals: null, failureCode: 'CREATIVE_PROPOSAL_COUNT' };
    const seen = new Set();
    const proposals = value.map(proposal => {
      if (!proposal || Array.isArray(proposal) || Object.keys(proposal).length !== 5 || Object.keys(proposal).some(key => !['candidateId', 'title', 'tagline', 'premise', 'shots'].includes(key))) throw new Error('Invalid proposal');
      const candidateId = text(proposal.candidateId, 'Creative candidate ID', 160);
      if (candidateId !== proposal.candidateId || !expectedIds.includes(candidateId) || seen.has(candidateId)) throw new AppError('CREATIVE_CANDIDATE_BINDING', 'The creative candidate binding is invalid.');
      if (!Array.isArray(proposal.shots) || proposal.shots.length !== 3) throw new AppError('CREATIVE_SHOT_COUNT', 'A proposal needs three shots.');
      seen.add(candidateId);
      return {
        candidateId, title: text(proposal.title, 'Creative title', 64), tagline: text(proposal.tagline, 'Creative tagline', 100), premise: proposedAction(proposal.premise, 'Creative premise', 320),
        shots: proposal.shots.map(shot => {
          if (!shot || Array.isArray(shot) || Object.keys(shot).length !== 2 || Object.keys(shot).some(key => !['label', 'note'].includes(key))) throw new Error('Invalid shot');
          return { label: text(shot.label, 'Shot label', 48), note: proposedAction(shot.note, 'Shot note', 180) };
        })
      };
    });
    return { proposals, failureCode: null };
  } catch (error) {
    const code = ['CREATIVE_ACTION_FORM', 'CREATIVE_CANDIDATE_BINDING', 'CREATIVE_SHOT_COUNT'].includes(error?.code) ? error.code : error?.code === 'VALIDATION' ? 'CREATIVE_TEXT_LIMIT' : 'CREATIVE_CONTRACT';
    return { proposals: null, failureCode: code };
  }
}

export function compareCandidates(candidates, dataMode) {
  const candidateSetHash = createHash('sha256').update(candidates.map(c => c.id).sort().join('|')).digest('hex');
  const base = { method: 'taste-vs-popularity', dataMode, candidateSetHash, available: false, tasteOrder: candidates.map(c => c.id), popularityOrder: [], changedPositions: [], top3Overlap: null };
  if (dataMode !== 'live') return { ...base, note: 'Sample mode demonstrates the workflow. It cannot measure Qloo against a popularity baseline.' };
  if (candidates.length < 2 || candidates.some(c => c.affinityRaw === null || c.popularityRaw === null)) return { ...base, note: 'The comparison needs at least two places with both Qloo affinity and popularity values.' };
  const taste = [...candidates].sort((a, b) => b.affinityRaw - a.affinityRaw || a.id.localeCompare(b.id));
  const popular = [...candidates].sort((a, b) => b.popularityRaw - a.popularityRaw || a.id.localeCompare(b.id));
  const n = Math.min(3, taste.length);
  return {
    ...base, available: true, tasteOrder: taste.map(c => c.id), popularityOrder: popular.map(c => c.id),
    changedPositions: taste.map((c, i) => ({ id: c.id, name: c.name, tasteRank: i + 1, popularityRank: popular.findIndex(p => p.id === c.id) + 1 })),
    top3Overlap: taste.slice(0, n).filter(c => popular.slice(0, n).some(p => p.id === c.id)).length,
    note: `Same ${candidates.length} candidate places, two ranking rules. A ranking difference does not prove better photography or individual preference.`
  };
}

async function scout(state, provider, planner, preserved = []) {
  let candidates = [];
  let filtered = false;
  let relaxed = false;
  let selectedIds = null;
  let selectedProposals = null;
  let proposalModel = null;
  let proposalFallback = false;
  const observations = [];
  const lockedIds = preserved.map(t => t.candidateId);
  for (let step = 0; step < 4; step++) {
    const available = step === 0 ? ['discover_places'] : ['select_treatments', ...(filtered && !relaxed ? ['relax_preferences'] : [])];
    const observationCandidates = [...preserved.map(t => t.candidate), ...candidates.filter(c => !lockedIds.includes(c.id))];
    const decision = await planner.choose({ available, brief: state.brief, candidates: observationCandidates, lockedIds, observations });
    if (!available.includes(decision.action)) throw new AppError('PLANNER_CONTRACT', 'The planner selected a tool outside this workflow.', 503);
    if (decision.fallback) state.warnings.push(decision.fallback);
    const plannerLabel = decision.planner === 'local-ollama' ? `Local model ${decision.model}` : decision.planner === 'groq' ? `Groq model ${decision.model}` : 'Bounded policy';
    const plannerDiagnostic = decision.fallbackDetailCodes?.length ? ` Diagnostic: ${decision.fallbackDetailCodes.join(', ')}.` : '';
    event(state, 'planner', `Allowed tools: ${available.join(', ')}. Observed ${candidates.length} places.`, `${plannerLabel} selected ${decision.action}.${decision.fallback ? ` ${decision.fallback}` : ''}${plannerDiagnostic}`, [], 'completed', { planner: decision.planner, model: decision.model ?? null, ...(decision.fallbackCode ? { fallbackCode: decision.fallbackCode } : {}) });
    if (decision.action === 'select_treatments') {
      selectedIds = [...new Set([...(decision.candidateIds ?? []), ...lockedIds])].slice(0, 2);
      if (lockedIds.some(id => !selectedIds.includes(id)) || selectedIds.some(id => !observationCandidates.some(c => c.id === id))) throw new AppError('PLANNER_CONTRACT', 'The planner selected an unknown or incompatible candidate.', 503);
      if (decision.planner === 'groq') {
        const creative = creativeProposals(decision.creativeProposals, selectedIds.filter(id => !lockedIds.includes(id)));
        selectedProposals = creative.proposals;
        proposalModel = decision.model;
        proposalFallback = creative.failureCode;
        if (proposalFallback) state.warnings.push('The model selected valid locations, but its creative proposals were missing or invalid. Authored templates were used for the new directions; venue evidence was not changed.');
      }
      break;
    }
    let tags = [];
    if (decision.action === 'discover_places' && decision.usePreferences && state.brief.placeKinds.length) {
      for (const kind of state.brief.placeKinds) {
        const found = await provider.findTags(kind);
        tags.push(...found);
        if (!found.length) state.warnings.push(`No exact category was confirmed for “${kind}”. It remains a creative preference, not a verified location filter.`);
        event(state, 'resolve_category', kind, found.length ? `Confirmed category ${found.map(t => t.name).join(', ')}.` : 'No exact category confirmed. This preference will not be asserted as a hard filter.', found.map(t => t.id));
      }
      filtered = tags.length > 0;
    }
    if (decision.action === 'relax_preferences') {
      relaxed = true;
      event(state, 'relax_preferences', `Only ${candidates.length} matching places.`, 'Removed the soft place-kind filter. Kept the city, cultural references, exclusions and locked choices.');
    }
    const started = performance.now();
    candidates = await provider.discover({ brief: state.brief, references: state.resolvedReferences, tags, take: 8 });
    observations.push({ tool: 'discover_places', count: candidates.length, filtered: tags.length > 0, city: state.brief.city });
    event(state, 'discover_places', `${state.brief.city}; ${state.resolvedReferences.length} references; ${tags.length ? 'confirmed place preferences' : 'all place kinds'}.`, `${candidates.length} candidate places returned${state.dataMode === 'fixture' ? ' by the authored sample fixture' : ' by Qloo'}.`, candidates.map(c => c.id), 'completed', { durationMs: Math.round(performance.now() - started) });
  }
  const pool = [...preserved.map(t => t.candidate), ...candidates.filter(c => !lockedIds.includes(c.id))];
  if (!selectedIds) selectedIds = [...new Set([...lockedIds, ...pool.map(c => c.id)])].slice(0, 2);
  state.candidates = candidates;
  const occupiedSlots = new Set(preserved.map(t => t.slot));
  state.treatments = selectedIds.map(id => {
    const fixed = preserved.find(t => t.candidateId === id);
    if (fixed) return fixed;
    const slot = occupiedSlots.has(0) ? 1 : 0;
    occupiedSlots.add(slot);
    return treatment(pool.find(c => c.id === id), slot, state.resolvedReferences, selectedProposals?.find(p => p.candidateId === id), proposalModel, proposalFallback);
  }).sort((a, b) => a.slot - b.slot);
  state.locks = state.treatments.filter(t => t.locked).map(t => t.id);
  state.comparison = compareCandidates(candidates, state.dataMode);
  state.status = state.treatments.length >= 2 ? 'ready' : 'insufficient';
  if (state.status === 'insufficient') state.warnings.push('This brief returned fewer than two usable places. Change a reference or the city; no location was invented.');
  const modelProposals = state.treatments.filter(t => t.editorial.source === 'model-proposed').length;
  event(state, 'build_treatments', `${pool.length} available places and ${preserved.length} locked decisions.`, `${state.treatments.length} editable treatments prepared: ${modelProposals} model-proposed and ${state.treatments.length - modelProposals} authored templates. Creative directions remain separate from Qloo taste evidence.`, state.treatments.map(t => t.candidateId), 'completed', { ...(proposalFallback ? { creativeFailureCode: proposalFallback } : {}) });
}

export async function rehearse(input, { provider, planner = createPolicyPlanner() } = {}) {
  const dataMode = validateMode(input?.dataMode);
  const brief = validateBrief(input?.brief ?? exampleById(input?.exampleId ?? 'quiet-city'));
  provider ??= providerFor(dataMode);
  if (provider.mode !== dataMode) throw new AppError('PROVIDER_MODE', 'The selected data source does not match the provider.', 503);
  const state = createState(brief, dataMode);
  await execute(state, provider, planner);
  return state;
}

async function execute(state, provider, planner, preserved = []) {
  // A fresh scout replaces operational warnings, not the research history.
  // Rebuild still-relevant limitations from the source and retained decisions.
  state.warnings = state.dataMode === 'fixture' ? [FIXTURE_NOTE] : [];
  if (preserved.some(t => t.candidate.city && normalize(t.candidate.city) !== normalize(state.brief.city))) {
    state.warnings.push('A fixed treatment belongs to a previous search city and needs a new location check; unlock it to replace it.');
  }
  if (preserved.some(t => t.editorial.fallbackCode)) {
    state.warnings.push('A fixed treatment retains authored text because its earlier model proposal was invalid. Its original fallback remains recorded on the treatment and in the research history.');
  }
  const ready = await resolveReferences(state, provider);
  if (!ready) {
    state.status = 'needs_input';
    state.candidates = [];
    state.comparison = null;
    state.treatments = preserved.map(t => ({ ...t, needsReview: true }));
    state.locks = state.treatments.map(t => t.id);
    event(state, 'pause_for_reference', `${state.resolutionIssues.length} unresolved reference(s).`, 'Cleared outdated candidates and comparison. Only fixed decisions remain as earlier evidence requiring review.', state.treatments.map(t => t.candidateId), 'needs_input');
  }
  else await scout(state, provider, planner, preserved);
  const actions = state.trace.filter(t => t.revision === state.revision && t.tool === 'planner');
  const modelActions = actions.filter(t => ['local-ollama', 'groq'].includes(t.planner)).length;
  const policyActions = actions.filter(t => t.planner === 'bounded-policy-v1').length;
  const actualPlanner = modelActions ? `${planner.name}${policyActions ? '-with-policy-fallback' : ''}` : 'bounded-policy-v1';
  state.provenance = {
    ...state.provenance, planner: actualPlanner, configuredPlanner: planner.name,
    model: modelActions ? planner.model : null, plannerCalls: planner.calls, modelActions, policyActions,
    qlooUsed: state.dataMode === 'live' && provider.requestCount > 0,
    retrievedAt: new Date().toISOString(), requestCount: provider.requestCount
  };
  state.warnings = [...new Set(state.warnings)];
}

export async function revise(previous, action, { provider, planner = createPolicyPlanner(), briefEdits } = {}) {
  if (!previous || previous.schemaVersion !== 'fieldwork.run.v1') throw new AppError('VALIDATION', 'Open a brief before revising it.');
  if (!action || !['veto', 'lock', 'unlock', 'change-reference', 'change-city'].includes(action.type)) throw new AppError('VALIDATION', 'Choose a supported revision action.');
  const state = structuredClone(previous);
  state.revision++;
  state.resolutionIssues = [];
  if (briefEdits !== undefined) {
    if (!briefEdits || typeof briefEdits !== 'object' || Array.isArray(briefEdits) || Object.keys(briefEdits).some(key => !['title', 'note'].includes(key))) throw new AppError('VALIDATION', 'Only the brief title and photographer note can be edited here.');
    if ('title' in briefEdits) state.brief.title = text(briefEdits.title, 'Brief title', 120);
    if ('note' in briefEdits) state.brief.note = text(briefEdits.note, 'Photographer note', 1200, false);
  }
  let target = state.treatments.find(t => t.id === action.targetId || t.candidateId === action.targetId);
  if (!target && action.type === 'veto') {
    const candidate = state.candidates.find(c => c.id === action.targetId);
    if (candidate) target = { candidateId: candidate.id, candidate, locked: false };
  }
  const reason = text(action.reason ?? '', 'Decision note', 400, false);
  if (['lock', 'unlock', 'veto'].includes(action.type) && !target) throw new AppError('VALIDATION', 'Choose a treatment in the current brief.');
  state.decisions.push({ id: randomUUID(), revision: state.revision, type: action.type, targetId: action.targetId ?? null, reason, at: new Date().toISOString() });
  if (state.decisions.length > 80) state.decisions = state.decisions.slice(-80);
  if (action.type === 'lock' || action.type === 'unlock') {
    target.locked = action.type === 'lock';
    if (target.locked) target.needsReview = false;
    state.locks = state.treatments.filter(t => t.locked).map(t => t.id);
    event(state, action.type, target.candidate.name, target.locked ? 'This treatment is fixed. Future revisions preserve it.' : 'This treatment can change on the next scout.', [target.candidateId]);
    return state;
  }
  if (action.type === 'veto') {
    if (target.locked) throw new AppError('LOCKED_TREATMENT', 'Unlock this treatment before rejecting it. The fixed decision was preserved.', 409);
    state.brief.avoidEntityIds = [...new Set([...state.brief.avoidEntityIds, target.candidateId])];
    if (state.brief.avoidEntityIds.length > 16) throw new AppError('VALIDATION', 'Start a new brief after sixteen exclusions.');
    event(state, 'veto', target.candidate.name, reason || 'The photographer rejected this candidate. It is excluded from subsequent searches.', [target.candidateId]);
  }
  if (action.type === 'change-reference') {
    if (!Number.isInteger(action.referenceIndex) || action.referenceIndex < 0 || action.referenceIndex >= state.brief.references.length) throw new AppError('VALIDATION', 'Choose an existing reference to change.');
    state.brief.references[action.referenceIndex] = validateReference(action.reference);
    state.treatments.filter(t => t.locked).forEach(t => { t.needsReview = true; });
    event(state, 'change_reference', `Reference ${action.referenceIndex + 1}.`, 'Updated the taste signal. Fixed treatments are retained and marked for review.');
  }
  if (action.type === 'change-city') {
    state.brief.city = text(action.city, 'City', 80);
    state.brief.avoidEntityIds = [];
    state.treatments.filter(t => t.locked).forEach(t => { t.needsReview = true; });
    event(state, 'change_city', state.brief.city, 'Changed the search city. Fixed treatments remain as decisions to review, not confirmed locations in the new city.');
  }
  provider ??= providerFor(state.dataMode);
  if (provider.mode !== state.dataMode) throw new AppError('PROVIDER_MODE', 'The selected data source does not match the provider.', 503);
  const preserved = state.treatments.filter(t => t.locked);
  state.comparison = null;
  await execute(state, provider, planner, preserved);
  return state;
}

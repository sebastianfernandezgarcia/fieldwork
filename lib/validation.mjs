import { AppError } from './errors.mjs';

export const DOMAINS = new Set(['movie', 'artist', 'book', 'brand', 'tv_show', 'podcast']);

export function text(value, name, max = 160, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new AppError('VALIDATION', `${name} must be text.`);
  const result = value.trim();
  if ((!result && required) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) {
    throw new AppError('VALIDATION', `${name} must contain ${required ? '1' : '0'}–${max} valid characters.`);
  }
  return result;
}

export function normalize(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function validateReference(value) {
  if (!value || typeof value !== 'object') throw new AppError('VALIDATION', 'A reference must have a query and domain.');
  const domain = text(value.domain, 'Reference domain', 16);
  if (!DOMAINS.has(domain)) throw new AppError('VALIDATION', 'Choose a supported cultural reference type.');
  return {
    query: text(value.query, 'Reference', 80), domain,
    ...(value.entityId ? { entityId: text(value.entityId, 'Reference ID', 160) } : {})
  };
}

export function validateBrief(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('VALIDATION', 'Provide a brief.');
  if (!Array.isArray(value.references) || value.references.length < 1 || value.references.length > 3) {
    throw new AppError('VALIDATION', 'Choose between one and three cultural references.');
  }
  const placeKinds = value.placeKinds ?? [];
  const avoidEntityIds = value.avoidEntityIds ?? [];
  if (!Array.isArray(placeKinds) || placeKinds.length > 2 || !Array.isArray(avoidEntityIds) || avoidEntityIds.length > 16) {
    throw new AppError('VALIDATION', 'Use at most two place preferences and sixteen exclusions.');
  }
  return {
    id: text(value.id ?? 'custom', 'Brief ID', 80),
    title: text(value.title ?? 'A new editorial portrait', 'Brief title', 120),
    city: text(value.city, 'City', 80),
    purpose: 'editorial_portrait',
    references: value.references.map(validateReference),
    note: text(value.note ?? '', 'Photographer note', 1200, false),
    placeKinds: [...new Set(placeKinds.map(v => text(v, 'Place preference', 40)))],
    avoidEntityIds: [...new Set(avoidEntityIds.map(v => text(v, 'Excluded entity ID', 160)))]
  };
}

export function validateMode(value = 'fixture') {
  if (!['fixture', 'live'].includes(value)) throw new AppError('VALIDATION', 'Choose fixture or live data explicitly.');
  return value;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

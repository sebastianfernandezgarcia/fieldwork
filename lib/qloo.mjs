import { AppError } from './errors.mjs';
import { normalize, safeUrl } from './validation.mjs';

const DOMAIN_TYPES = { movie: 'urn:entity:movie', artist: 'urn:entity:artist', book: 'urn:entity:book', brand: 'urn:entity:brand', tv_show: 'urn:entity:tv_show', podcast: 'urn:entity:podcast' };
const OFFICIAL_HOSTS = new Set(['api.qloo.com', 'hackathon.api.qloo.com', 'staging.api.qloo.com']);
const arrayAt = (response, key) => Array.isArray(response?.results) ? response.results : Array.isArray(response?.results?.[key]) ? response.results[key] : [];
const short = (value, max = 1000) => typeof value === 'string' ? value.slice(0, max) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function bounded(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => bounded(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k, bounded(v, depth + 1)]));
  return null;
}

export class QlooProvider {
  constructor({ apiKey, baseUrl = 'https://api.qloo.com', fetchImpl = fetch, timeoutMs = 10000, maxRequests = 10, beforeRequest = () => {} } = {}) {
    if (!apiKey) throw new AppError('QLOO_NOT_CONFIGURED', 'Live Qloo is not configured. Sample mode is available; it is not a Qloo result.', 503);
    let url;
    try { url = new URL(baseUrl); } catch { throw new AppError('QLOO_CONFIGURATION', 'The Qloo endpoint configuration is invalid.', 503); }
    if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new AppError('QLOO_CONFIGURATION', 'Use the official Qloo endpoint assigned to your event credential.', 503);
    }
    this.apiKey = apiKey;
    this.baseUrl = url.origin;
    this.fetchImpl = fetchImpl;
    if (typeof beforeRequest !== 'function') throw new AppError('QLOO_CONFIGURATION', 'The Qloo request guard configuration is invalid.', 503);
    this.beforeRequest = beforeRequest;
    this.timeoutMs = timeoutMs;
    this.maxRequests = maxRequests;
    this.requestCount = 0;
    this.mode = 'live';
  }

  async request(path, query) {
    if (this.requestCount >= this.maxRequests) throw new AppError('TOOL_BUDGET', 'This run reached its Qloo request limit. Review the current candidates before trying again.', 429);
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) if (value != null && value !== '') url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    // The shared quota reservation must run outside the transport catch so its
    // safe 429 reaches the caller unchanged. It never receives the credential.
    this.beforeRequest({ provider: 'qloo', operation: path === '/search' ? 'search' : path === '/v2/tags' ? 'tags' : 'insights' });
    this.requestCount++;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch (error) {
      if (['AbortError', 'TimeoutError'].includes(error?.name)) throw new AppError('QLOO_TIMEOUT', 'Qloo did not respond in time. No sample results were substituted.', 504);
      throw new AppError('QLOO_UPSTREAM', 'Qloo could not be reached. No sample results were substituted.', 503);
    }
    if ([401, 403].includes(response.status)) throw new AppError('QLOO_AUTH', 'Qloo did not accept the server credential. Check the event access configuration.', 401);
    if (response.status === 429) throw new AppError('QLOO_RATE_LIMIT', 'The Qloo quota or rate limit was reached. This run stopped without changing data sources.', 429);
    // Search documents 404 as no matches. Other endpoints keep their error path.
    if (path === '/search' && response.status === 404) return { success: true, results: [] };
    if (!response.ok) throw new AppError('QLOO_UPSTREAM', 'Qloo could not complete this request. Try a smaller or different brief.', 503);
    if (Number(response.headers.get('content-length')) > 2_000_000) throw new AppError('QLOO_CONTRACT', 'Qloo returned more data than this brief can safely use.', 503);
    let content;
    try { content = await response.text(); } catch { throw new AppError('QLOO_UPSTREAM', 'The Qloo response could not be read.', 503); }
    if (content.length > 2_000_000) throw new AppError('QLOO_CONTRACT', 'Qloo returned more data than this brief can safely use.', 503);
    if (this.apiKey.length >= 8 && content.includes(this.apiKey)) throw new AppError('QLOO_CONTRACT', 'The upstream response contained private server configuration and was withheld.', 503);
    let data;
    try { data = JSON.parse(content); } catch { throw new AppError('QLOO_CONTRACT', 'Qloo returned an unexpected response.', 503); }
    if (data?.success === false || !data || typeof data !== 'object') throw new AppError('QLOO_UPSTREAM', 'Qloo did not return a successful result for this brief.', 503);
    return data;
  }

  async search(query, domain) {
    const data = await this.request('/search', { query, types: DOMAIN_TYPES[domain], take: 5 });
    return arrayAt(data, 'entities').filter(e => e && typeof e.entity_id === 'string' && typeof e.name === 'string' && (!e.subtype || e.subtype === DOMAIN_TYPES[domain])).slice(0, 5).map(e => ({
      id: e.entity_id, name: short(e.name, 180), domain,
      disambiguation: short(e.disambiguation || e.properties?.short_description || e.properties?.release_year?.toString(), 200), source: 'qloo'
    }));
  }

  async findTags(kind) {
    const data = await this.request('/v2/tags', { 'filter.query': kind, 'feature.semantic_search': true, take: 5 });
    const candidates = arrayAt(data, 'tags').flatMap(tag => {
      const id = typeof tag?.id === 'string' && tag.id ? tag.id : tag?.tag_id;
      if (typeof id !== 'string' || !id || typeof tag?.name !== 'string') return [];
      const parentTypes = Array.isArray(tag.parents) ? tag.parents.map(parent => parent?.type).filter(type => typeof type === 'string' && type) : [];
      return [{ id, name: tag.name, parentTypes }];
    });
    // Follow the official resolver's local scope check when parent metadata is
    // available. Missing or ambiguous matches remain soft creative preferences.
    const scoped = candidates.some(tag => tag.parentTypes.length) ? candidates.filter(tag => tag.parentTypes.includes('urn:entity:place')) : candidates;
    const exact = [...new Map(scoped.filter(tag => normalize(tag.name) === normalize(kind)).map(tag => [tag.id, tag])).values()];
    return exact.length === 1 ? [{ id: exact[0].id, name: short(exact[0].name, 100), source: 'qloo' }] : [];
  }

  async discover({ brief, references, tags = [], take = 8, candidateIds }) {
    const query = {
      'filter.type': 'urn:entity:place', 'signal.interests.entities': references.map(r => r.id),
      'filter.location.query': brief.city, 'filter.location.radius': 0, 'feature.explainability': true, take,
      ...(tags.length ? { 'filter.tags': tags.map(t => t.id), 'operator.filter.tags': 'union' } : {}),
      ...(brief.avoidEntityIds.length ? { 'filter.exclude.entities': brief.avoidEntityIds } : {}),
      ...(candidateIds?.length ? { 'filter.results.entities': candidateIds } : {})
    };
    const data = await this.request('/v2/insights', query);
    const retrievedAt = new Date().toISOString();
    const excluded = new Set(brief.avoidEntityIds);
    const seen = new Set();
    return arrayAt(data, 'entities').filter(e => {
      if (!e || typeof e.entity_id !== 'string' || typeof e.name !== 'string' || (e.subtype && e.subtype !== 'urn:entity:place') || excluded.has(e.entity_id) || seen.has(e.entity_id)) return false;
      seen.add(e.entity_id); return true;
    }).slice(0, take).map((e, index) => {
      const p = e.properties ?? {};
      const imageUrl = safeUrl(p.image?.url);
      const tags = Array.isArray(e.tags) ? e.tags.map(t => t.name).filter(t => typeof t === 'string') : [];
      const kind = tags.find(t => /gallery|bookshop|bookstore|garden|caf[eé]|museum|courtyard/i.test(t)) ?? 'place';
      return {
        id: e.entity_id, name: short(e.name, 180), kind: short(kind, 80), city: brief.city,
        description: short(p.description || p.short_description),
        address: typeof p.address === 'string' ? short(p.address, 240) : null,
        // Do not render upstream imagery until reuse/display rights have been verified.
        image: imageUrl ? { sourceUrl: imageUrl, attribution: 'Qloo entity metadata', licenseStatus: 'unverified', kind: 'venue' } : null,
        rank: index + 1, affinityRaw: number(e.affinity ?? e.query?.affinity), popularityRaw: number(e.popularity),
        source: 'qloo', explanation: bounded(e.query?.explainability ?? null),
        sourceQuery: query, retrievedAt
      };
    });
  }
}

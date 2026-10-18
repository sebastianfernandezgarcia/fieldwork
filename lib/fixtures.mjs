import { normalize } from './validation.mjs';

export const FIXTURE_NOTE = 'Synthetic demonstration. The venues and ordering are authored examples, not Qloo results.';

export const EXAMPLES = [
  {
    id: 'quiet-city', title: 'A portrait that feels like a record sleeve', city: 'Barcelona', purpose: 'editorial_portrait',
    references: [{ query: 'In the Mood for Love', domain: 'movie' }, { query: 'Khruangbin', domain: 'artist' }, { query: 'Aesop', domain: 'brand' }],
    note: 'An intimate editorial portrait. A face, a little tension and a city that stays in the background.',
    placeKinds: ['bookshop', 'gallery'], avoidEntityIds: []
  },
  {
    id: 'graphic-city', title: 'A new chapter, in full colour', city: 'Madrid', purpose: 'editorial_portrait',
    references: [{ query: 'Amélie', domain: 'movie' }, { query: 'Rosalía', domain: 'artist' }, { query: 'Camper', domain: 'brand' }],
    note: 'A portrait for a first independent release. Confident shapes, movement and a strong cover frame.',
    placeKinds: ['gallery', 'courtyard'], avoidEntityIds: []
  },
  {
    id: 'slow-city', title: 'A slower kind of afternoon', city: 'Lisbon', purpose: 'editorial_portrait',
    references: [{ query: 'Perfect Days', domain: 'movie' }, { query: 'Ryuichi Sakamoto', domain: 'artist' }, { query: 'Muji', domain: 'brand' }],
    note: 'An artist portrait with room to breathe. Quiet gestures, unforced details and space around the subject.',
    placeKinds: ['garden', 'bookshop'], avoidEntityIds: []
  }
];

const REFERENCES = [
  ['In the Mood for Love', 'movie', '2000, Wong Kar-wai'], ['Khruangbin', 'artist', 'American musical trio'], ['Aesop', 'brand', 'Personal care brand'],
  ['Amélie', 'movie', '2001, Jean-Pierre Jeunet'], ['Rosalía', 'artist', 'Spanish singer and songwriter'], ['Camper', 'brand', 'Footwear brand'],
  ['Perfect Days', 'movie', '2023, Wim Wenders'], ['Ryuichi Sakamoto', 'artist', 'Japanese composer'], ['Muji', 'brand', 'Retail brand'],
  ['Paterson', 'movie', '2016, Jim Jarmusch'], ['Nils Frahm', 'artist', 'German musician'], ['The Little Prince', 'book', 'Antoine de Saint-Exupéry'],
  ['Dune', 'movie', '2021, Denis Villeneuve'], ['Dune', 'movie', '1984, David Lynch'], ['Dune', 'book', '1965, Frank Herbert']
].map(([name, domain, disambiguation], i) => ({ id: `sample:reference:${i + 1}`, name, domain, disambiguation, source: 'fixture' }));

const VENUES = [
  ['paper-room', 'The Paper Room', 'bookshop', 'A fictional bookshop setting with shelves, a reading table and a narrow front window.'],
  ['still-gallery', 'Still Gallery', 'gallery', 'A fictional gallery setting with a pale wall and an open central room.'],
  ['west-courtyard', 'West Courtyard', 'courtyard', 'A fictional courtyard setting with a long wall and a small tree.'],
  ['green-room', 'The Green Room', 'garden', 'A fictional garden setting with foliage, a path and a stone bench.'],
  ['corner-table', 'Corner Table', 'café', 'A fictional café setting with two stools and a street-facing window.'],
  ['arcade-seven', 'Arcade Seven', 'passage', 'A fictional covered passage with repeated columns and a long view.'],
  ['print-house', 'The Print House', 'gallery', 'A fictional print workshop setting with a large worktable and paper on the walls.'],
  ['small-hours', 'Small Hours', 'bookshop', 'A fictional reading room setting with a single chair and deep shelves.']
];

export class FixtureProvider {
  constructor() { this.mode = 'fixture'; this.requestCount = 0; }

  async search(query, domain) {
    this.requestCount++;
    const q = normalize(query);
    return REFERENCES.filter(r => r.domain === domain && (normalize(r.name).includes(q) || q.includes(normalize(r.name))));
  }

  async findTags(kind) {
    this.requestCount++;
    return [{ id: `sample:tag:${normalize(kind)}`, name: kind, source: 'fixture' }];
  }

  async discover({ brief, references, tags = [], take = 8 }) {
    this.requestCount++;
    const citySlug = normalize(brief.city).replaceAll(' ', '-');
    const excluded = new Set(brief.avoidEntityIds);
    // An authored demonstration order, deliberately not a simulated Qloo score.
    const alternate = references.some(r => ['Paterson', 'Nils Frahm', 'The Little Prince'].includes(r.name));
    const preferred = alternate ? ['garden', 'passage', 'courtyard'] : brief.id === 'graphic-city' ? ['gallery', 'courtyard', 'passage'] : brief.id === 'slow-city' ? ['garden', 'bookshop', 'café'] : ['bookshop', 'gallery', 'courtyard'];
    const matchingKinds = tags.map(t => normalize(t.name));
    let venues = VENUES.map(([slug, name, kind, description], index) => ({
      id: `sample:place:${citySlug}:${slug}`, name, kind, city: brief.city, description, address: null, image: null,
      rank: index + 1, affinityRaw: null, popularityRaw: null, source: 'fixture', explanation: null,
      sourceQuery: { fixture: true, city: brief.city, referenceIds: references.map(r => r.id), kinds: matchingKinds },
      retrievedAt: new Date().toISOString()
    })).filter(v => !excluded.has(v.id));
    if (matchingKinds.length) venues = venues.filter(v => matchingKinds.includes(normalize(v.kind)));
    venues.sort((a, b) => (preferred.indexOf(a.kind) < 0 ? 99 : preferred.indexOf(a.kind)) - (preferred.indexOf(b.kind) < 0 ? 99 : preferred.indexOf(b.kind)));
    return venues.slice(0, take).map((v, index) => ({ ...v, rank: index + 1 }));
  }
}

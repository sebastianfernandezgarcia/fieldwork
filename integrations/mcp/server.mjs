import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// This bridge only reaches a local FIELDWORK process. Qloo credentials belong
// to that process and never enter an MCP argument or result.
const origin = new URL(process.env.FIELDWORK_URL || 'http://127.0.0.1:4322');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    || origin.protocol !== 'http:' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('FIELDWORK_URL must be a loopback HTTP origin without credentials or a path.');
}

const server = new McpServer({ name: 'fieldwork', version: '0.1.0' });
const mode = z.enum(['fixture', 'live']).default('fixture');
const domain = z.enum(['movie', 'artist', 'book', 'brand', 'tv_show', 'podcast']);
const reference = z.object({
  query: z.string().trim().min(1).max(80),
  domain,
  entityId: z.string().min(1).max(160).optional(),
});
const brief = z.object({
  title: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(80),
  purpose: z.string().max(80).default('editorial_portrait'),
  references: z.array(reference).min(1).max(3),
  note: z.string().max(1200).default(''),
  placeKinds: z.array(z.string().max(40)).max(2).default([]),
});

async function call(path, body) {
  try {
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
      redirect: 'error',
    });
    const value = await response.json();
    if (!response.ok) {
      // Forward only the documented safe error shape, never upstream headers.
      const error = {
        code: typeof value.error?.code === 'string' ? value.error.code : 'FIELDWORK_ERROR',
        message: typeof value.error?.message === 'string' ? value.error.message : 'FIELDWORK could not complete this action.',
      };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: {
        code: 'LOCAL_SERVICE_UNAVAILABLE',
        message: 'The local FIELDWORK service did not return a usable response. Start the app and retry. No sample fallback was used.',
      } }) }],
    };
  }
}

server.registerTool('fieldwork_status', {
  description: 'Check whether the local FIELDWORK service is running and whether Qloo and a local planner are configured. Configuration is not evidence of a successful live request.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
}, () => call('/api/health'));

server.registerTool('fieldwork_examples', {
  description: 'List synthetic photography briefs. These examples are not client records or real Qloo responses.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
}, () => call('/api/examples'));

server.registerTool('fieldwork_resolve_reference', {
  description: 'Resolve a cultural reference before using it in a photography brief. Inspect ambiguity and ask the photographer to choose when needed. Fixture data is synthetic. Live mode requires a configured Qloo key in the app server.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: { query: z.string().trim().min(1).max(80), domain, dataMode: mode },
}, ({ query, domain, dataMode }) => call(`/api/search?${new URLSearchParams({ query, domain, dataMode })}`));

server.registerTool('fieldwork_rehearse', {
  description: 'Create a local photography preproduction run from a brief or a built-in example. Produces at most two treatments, candidate evidence, a bounded tool trace and operational checks. Preserve dataMode and provenance in every summary. Qloo affinity is not visual similarity, permission, availability or a personal probability. This does not book or contact a location.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputSchema: { exampleId: z.string().max(120).optional(), brief: brief.optional(), dataMode: mode },
}, (input) => call('/api/rehearse', input));

const commonAction = { reason: z.string().max(400).optional() };
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lock'), targetId: z.string().max(240), ...commonAction }),
  z.object({ type: z.literal('unlock'), targetId: z.string().max(240), ...commonAction }),
  z.object({ type: z.literal('veto'), targetId: z.string().max(240), ...commonAction }),
  z.object({ type: z.literal('change-reference'), referenceIndex: z.number().int().min(0).max(2), reference, ...commonAction }),
  z.object({ type: z.literal('change-city'), city: z.string().trim().min(1).max(80), ...commonAction }),
]);

server.registerTool('fieldwork_revise', {
  description: 'Revise a known local run, using its latest runId and revision. Supports locking, unlocking, vetoing, or changing a reference/city. A lock preserves a photographer decision; ask before unlocking it. The server owns canonical state and rejects stale revisions. Return the changed decisions and unresolved checks. No messages, booking or payment are sent.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputSchema: { runId: z.string().min(1).max(120), revision: z.number().int().positive(), action },
}, ({ runId, revision, action }) => call('/api/revise', { state: { runId, revision }, action }));

await server.connect(new StdioServerTransport());

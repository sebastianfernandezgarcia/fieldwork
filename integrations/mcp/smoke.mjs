import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// A real stdio MCP client → local HTTP server → engine rehearsal.
// It intentionally uses fixtures and cannot be counted as a Qloo API test.
const client = new Client({ name: 'fieldwork-acceptance', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: ['server.mjs'], cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { FIELDWORK_URL: process.env.FIELDWORK_URL || 'http://127.0.0.1:4322' },
});
const value = result => {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const initial = value(await client.callTool({ name: 'fieldwork_rehearse', arguments: { exampleId: 'quiet-city', dataMode: 'fixture' } }));
  assert.equal(initial.status, 'ready');
  assert.equal(initial.provenance.qlooUsed, false);
  assert.equal(initial.treatments.length, 2);
  const first = initial.treatments[0];
  const rejected = initial.treatments[1];
  const fixed = value(await client.callTool({ name: 'fieldwork_revise', arguments: {
    runId: initial.runId, revision: initial.revision, action: { type: 'lock', targetId: first.id },
  } }));
  const replanned = value(await client.callTool({ name: 'fieldwork_revise', arguments: {
    runId: fixed.runId, revision: fixed.revision, action: { type: 'veto', targetId: rejected.id, reason: 'Synthetic acceptance case: owner rejects this setting.' },
  } }));
  assert.ok(replanned.treatments.some(t => t.id === first.id && t.locked));
  assert.ok(!replanned.treatments.some(t => t.id === rejected.id));
  assert.equal(replanned.revision, 3);
  assert.equal(replanned.dataMode, 'fixture');
  const stale = await client.callTool({ name: 'fieldwork_revise', arguments: {
    runId: initial.runId, revision: 1, action: { type: 'unlock', targetId: first.id },
  } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STALE_REVISION/);
  console.log(JSON.stringify({
    verifiedAt: new Date().toISOString(), boundary: 'MCP stdio → HTTP → FIELDWORK engine',
    result: 'passed', dataMode: 'fixture', qlooApiTest: false,
    tools: tools.tools.map(t => t.name), revisions: [initial.revision, fixed.revision, replanned.revision],
    fixed: first.candidate.name, rejected: rejected.candidate.name,
    finalLocations: replanned.treatments.map(t => t.candidate.name),
    checks: ['two treatments', 'fixture provenance', 'lock preserved', 'veto replaced', 'stale revision rejected'],
  }, null, 2));
} finally {
  await client.close();
}

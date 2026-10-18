import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
test('MCP client can discover tools and preserve state revisions across the HTTP boundary', async () => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: body ? JSON.parse(body) : undefined });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, qlooConfigured: false }));
    if (req.url === '/api/rehearse') return res.end(JSON.stringify({ runId: 'test-run', revision: 1, dataMode: 'fixture', provenance: { qlooUsed: false } }));
    if (req.url === '/api/revise') {
      if (JSON.parse(body).state.revision === 1) return res.end(JSON.stringify({ runId: 'test-run', revision: 2, dataMode: 'fixture', locks: ['treatment:paper-room'] }));
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: { code: 'STALE_REVISION', message: 'Use the latest revision.' }, internalToken: 'must-not-leak' }));
    }
    return res.end(JSON.stringify({ status: 'needs_input', dataMode: 'fixture', candidates: [] }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'fieldwork-boundary-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server.mjs'], cwd: dir, env: { FIELDWORK_URL: `http://127.0.0.1:${api.address().port}` } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 5);
    assert.ok(tools.tools.some(x => x.name === 'fieldwork_revise'));
    const status = await client.callTool({ name: 'fieldwork_status', arguments: {} });
    assert.equal(status.structuredContent.qlooConfigured, false);
    const created = await client.callTool({ name: 'fieldwork_rehearse', arguments: { exampleId: 'quiet-city' } });
    assert.equal(created.structuredContent.dataMode, 'fixture');
    assert.equal(requests.at(-1).body.dataMode, 'fixture');
    const revised = await client.callTool({ name: 'fieldwork_revise', arguments: { runId: 'test-run', revision: 1, action: { type: 'lock', targetId: 'treatment:paper-room' } } });
    assert.equal(revised.structuredContent.revision, 2);
    assert.deepEqual(requests.at(-1).body.state, { runId: 'test-run', revision: 1 });
    const conflict = await client.callTool({ name: 'fieldwork_revise', arguments: { runId: 'test-run', revision: 5, action: { type: 'veto', targetId: 'missing' } } });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /STALE_REVISION/);
    assert.doesNotMatch(conflict.content[0].text, /must-not-leak/);
    const count = requests.length;
    const invalid = await client.callTool({ name: 'fieldwork_revise', arguments: { runId: 'test-run', revision: -1, action: { type: 'pay', targetId: 'anything' } } });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, count);
    await client.callTool({ name: 'fieldwork_resolve_reference', arguments: { query: 'A&B / midnight', domain: 'movie', dataMode: 'fixture' } });
    assert.equal(new URL(requests.at(-1).path, 'http://local').searchParams.get('query'), 'A&B / midnight');
  } finally {
    await client.close();
    await new Promise(resolve => api.close(resolve));
  }
});

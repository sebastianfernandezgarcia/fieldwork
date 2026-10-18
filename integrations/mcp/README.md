# FIELDWORK tools for a local agent

This optional bridge lets an MCP-compatible agent resolve cultural references, create a photography brief and revise it through the same FIELDWORK engine as the web app. The server keeps the canonical run and rejects stale revisions. The bridge does not book locations, send messages or move money.

Start the main FIELDWORK app first on `127.0.0.1:4322`. In this directory, run `npm ci`, then add this configuration to your chosen MCP client using its normal approval flow:

```json
{
  "mcpServers": {
    "fieldwork": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/fieldwork/integrations/mcp/server.mjs"]
    }
  }
}
```

No agent configuration has been installed automatically. Replace the path with your checkout. Node 20.19 or later is required. `FIELDWORK_URL` can select a different loopback HTTP port; remote destinations and credentials in this URL are rejected. Qloo credentials stay in the app server, never in an MCP argument.

An example request to the agent:

> Open FIELDWORK's quiet-city sample brief. Show the two treatments and their data provenance. Fix the first treatment, veto the second and explain what changed. Keep unverified access and permission checks visible.

All tools default to `fixture` mode. Synthetic examples do not count as Qloo integration evidence. Live mode only works when the separate app server is correctly configured and has successful access. Never describe cultural affinity as visual similarity or a personal probability, and never hide a live error behind sample output.

`npm test` tests a real MCP client/stdio transport against a controlled HTTP stub. It verifies tool discovery, typed input rejection, revision handoff, URL encoding and safe error shape. It does **not** prove a call to Qloo. The main app has its own functional tests; use the real app for the complete evaluation.

The bridge and its tests form one optional integration unit. Remove `integrations/mcp/` to roll it back without affecting the web app. SDK use follows the [official TypeScript SDK server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md).

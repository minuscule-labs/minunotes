# MinuNotes

MinuNotes is a note-first markdown/canvas workspace with external agent integrations through a stable harness API, MCP, and OAuth.

## Production endpoints

- Web app: `https://notes.minusculelabs.com`
- API origin: `https://api.notes.minusculelabs.com`
- Health check: `https://api.notes.minusculelabs.com/health`

## API surfaces

- Internal app API: `/internal/*`
- External harness API: `/v1/harness/*`
- MCP endpoint: `/mcp`
- OAuth endpoints: `/oauth/*`
- OpenAPI: `/openapi.json` and `/v1/openapi.json`

Legacy `/api/*` routes have been removed from production.

## Discovery endpoints

- OAuth authorization server metadata: `/.well-known/oauth-authorization-server`
- OAuth protected resource metadata: `/.well-known/oauth-protected-resource`
- MCP protected resource metadata: `/mcp/.well-known/oauth-protected-resource`

Full production URLs:

```txt
https://api.notes.minusculelabs.com/.well-known/oauth-authorization-server
https://api.notes.minusculelabs.com/.well-known/oauth-protected-resource
https://api.notes.minusculelabs.com/mcp/.well-known/oauth-protected-resource
```

## Agent integrations

- Harness/OpenAPI clients should use `https://api.notes.minusculelabs.com/v1/harness/*`.
- MCP clients should use `https://api.notes.minusculelabs.com/mcp`.
- OAuth-capable clients should discover metadata from `https://api.notes.minusculelabs.com/.well-known/oauth-authorization-server`.
- API-key based local/private agents should send `X-API-Key` to `/v1/harness/*`.

## Local verification

- `pnpm ci:local`: typecheck, unit/API tests, build, and focused Board/properties browser coverage.
- `pnpm test:browser`: all ordinary browser tests, without the Board demo.
- `pnpm board:demo`: manual disposable Board sandbox (unchanged).
- `pnpm test:demo`: opt-in demo startup/shutdown and port-conflict tests.
- `pnpm test:browser:demo`: opt-in demo-backed full-stack browser tests; starts only the demo API/frontend, not the ordinary Vite server.

Browser tests require `pnpm exec playwright install chromium`. Demo tests own ports 3181/5181; stop any manual demo and run the two demo suites separately.
Sandbox safety, permissions, persistence, transactions, and retry coverage remain in normal tests.

## Docs

See [docs/README.md](./docs/README.md).

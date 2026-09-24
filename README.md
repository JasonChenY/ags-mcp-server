# ags-remote-mcp

Remote, multi-user browser MCP server for **Tencent Cloud AgentSandbox (AGS)**.

It is a thin, standalone service that wraps Playwright's built-in MCP implementation
(shipped inside `playwright-core` as `coreBundle.tools.createConnection`) and adds:

- **OAuth2 Resource Server** auth over HTTP(S) — validates a Keycloak-issued `Bearer` JWT
  (JWKS signature + `iss`/`aud`/`exp`), RFC 9728 protected-resource metadata, and 401 challenge.
- **Per-user AgentSandbox backend** — each authenticated user (`sub`) gets an isolated E2B/AGS
  browser sandbox, injected into Playwright MCP via the `createConnection(config, contextGetter)`
  hook (CDP over HTTPS with an `X-Access-Token` header).
- **Sandbox lifecycle** — idle sandboxes auto-hibernate (`lifecycle.onTimeout='pause'`,
  `autoResume`), resume on next use, and are tracked in PostgreSQL (released rows kept as history).
- **Sandbox-management tools** — `browser_sandbox_pause` / `browser_sandbox_delete`, merged into
  Playwright's core tool set.

It depends only on `playwright-core` (no dependency on the `@playwright/mcp` wrapper package).

## Build & run

```bash
npm ci
npm run build        # tsc -> lib/
node lib/cli.js      # configured entirely via env (see below)
```

## Configuration (environment variables)

| Env | Purpose |
|-----|---------|
| `E2B_API_KEY`, `E2B_DOMAIN` | AGS sandbox platform credentials (e.g. `ap-shanghai.tencentags.com`) |
| `AGS_MCP_HOST` / `AGS_MCP_PORT` | bind host/port (default `0.0.0.0` / `8931`) |
| `AGS_MCP_OIDC_ISSUER` | Keycloak issuer, e.g. `https://keycloak.eit217.cn/realms/eit217` |
| `AGS_MCP_RESOURCE_URL` | canonical resource URL advertised in metadata |
| `AGS_MCP_AUDIENCE` | expected token `aud` (Keycloak client-audience mapper value, e.g. `ags-mcp-api`) |
| `AGS_MCP_ALLOWED_AZP` | optional comma-separated `azp` (client_id) allowlist |
| `AGS_MCP_JWKS_URI` | override JWKS URL (defaults to `${issuer}/protocol/openid-connect/certs`) |
| `AGS_MCP_TLS_CERT` / `AGS_MCP_TLS_KEY` | optional in-process HTTPS (else terminate TLS at a reverse proxy) |
| `AGS_MCP_DATABASE_URL` | optional PostgreSQL connection for the user→sandbox mapping |
| `AGS_MCP_SANDBOX_TEMPLATE` | sandbox template (default `browser-v1`) |
| `AGS_MCP_SANDBOX_TIMEOUT_MS` | idle-before-hibernate timeout (default `300000`) |

Auth is enabled only when both `AGS_MCP_OIDC_ISSUER` and `AGS_MCP_RESOURCE_URL` are set;
otherwise the server runs open (local/dev).

## Docker

See `Dockerfile`. Terminate TLS at a reverse proxy (recommended) or mount certs and set
`AGS_MCP_TLS_CERT`/`AGS_MCP_TLS_KEY`. When the Keycloak hostname resolves via a slow DNS in the
container, pin it: `docker run --add-host keycloak.eit217.cn:<internal-ip> ...`.

## Upstream tracking

The browser tools come from `playwright-core` (pinned in `package.json`). To pick up upstream
changes, bump the `playwright-core` version and re-test — note `createConnection` /
`coreBundle` are internal Playwright APIs and may change between releases.

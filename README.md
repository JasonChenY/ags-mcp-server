# ags-remote-mcp

Remote, multi-user browser MCP server for **Tencent Cloud AgentSandbox (AGS)**.

It is a thin, standalone service that wraps Playwright's built-in MCP implementation
(shipped inside `playwright-core` as `coreBundle.tools.createConnection`) and adds:

- **OAuth2 Resource Server** auth over HTTP(S) — validates a Keycloak-issued `Bearer` token,
  either by **token introspection** (RFC 7662, confidential client) or local **JWKS** signature
  verification. Serves RFC 9728 protected-resource metadata and a 401 challenge.
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

On startup the server logs the active auth mode and Playwright capabilities, e.g.:

```
Auth: confidential-client introspection  client_id=ags-mcp-server  issuer=https://keycloak.eit217.cn/realms/eit217
Playwright caps: vision, pdf
AGS remote MCP server listening on https://0.0.0.0:8443/mcp
```

## Configuration (environment variables)

| Env | Purpose |
|-----|---------|
| `E2B_API_KEY`, `E2B_DOMAIN` | AGS sandbox platform credentials (e.g. `ap-shanghai.tencentags.com`) |
| `AGS_MCP_HOST` / `AGS_MCP_PORT` | bind host/port (default `0.0.0.0` / `8931`) |
| `AGS_MCP_OIDC_ISSUER` | Keycloak issuer, e.g. `https://keycloak.eit217.cn/realms/eit217` |
| `AGS_MCP_RESOURCE_URL` | canonical resource URL advertised in metadata |
| `AGS_MCP_CLIENT_ID` | confidential-client id for token introspection (e.g. `ags-mcp-server`) |
| `AGS_MCP_CLIENT_SECRET` | secret paired with `AGS_MCP_CLIENT_ID`; enables introspection when both are set |
| `AGS_MCP_AUDIENCE` | expected token `aud` (Keycloak audience mapper value, e.g. `ags-mcp-server`) |
| `AGS_MCP_ALLOWED_AZP` | optional comma-separated `azp` (client_id) allowlist |
| `AGS_MCP_JWKS_URI` | override JWKS URL for local verification (defaults to `${issuer}/protocol/openid-connect/certs`) |
| `AGS_MCP_TLS_CERT` / `AGS_MCP_TLS_KEY` | optional in-process HTTPS (else terminate TLS at a reverse proxy) |
| `AGS_MCP_DATABASE_URL` | optional PostgreSQL connection for the user→sandbox mapping |
| `AGS_MCP_SANDBOX_TEMPLATE` | sandbox template (default `browser-v1`) |
| `AGS_MCP_SANDBOX_TIMEOUT_MS` | idle-before-hibernate timeout (default `300000`) |
| `EXPORT_PLAYWRIGHT_TOOLS` | when `false`, hide Playwright's `browser_*` tools (serve only `sandbox_*`; default `true`) |
| `PLAYWRIGHT_MCP_CAPS` | comma-separated extra Playwright MCP capabilities, e.g. `vision,pdf,devtools` (same values as playwright-mcp's `--caps`) |

Auth is enabled only when both `AGS_MCP_OIDC_ISSUER` and `AGS_MCP_RESOURCE_URL` are set;
otherwise the server runs open (local/dev).

## Authentication

The server is an OAuth2 **Resource Server**. It validates the `Bearer` access token on every
request and derives the caller identity from `sub` (used to isolate the per-user sandbox).

Two verification modes, chosen automatically:

- **Confidential-client introspection (recommended)** — set `AGS_MCP_CLIENT_ID` +
  `AGS_MCP_CLIENT_SECRET`. The server discovers the `introspection_endpoint` from the OIDC
  Discovery document (`${issuer}/.well-known/openid-configuration`) and calls Keycloak's
  introspection endpoint (RFC 7662). Works for opaque tokens and honours real-time revocation.
- **JWKS local verification (fallback)** — when no client credentials are set, the server
  validates the JWT signature against the issuer's JWKS. No network call per request, but
  revocation only takes effect at key-rotation cadence.

Both modes additionally enforce `iss`, `aud` (`AGS_MCP_AUDIENCE`, defaults to the resource URL),
and, if configured, the `azp` allowlist (`AGS_MCP_ALLOWED_AZP`).

### Keycloak: two clients

The confidential client used by the server must be **separate** from the public client used by
end-user MCP clients — never share a confidential secret with software running on user devices.

| Client | Type | Used by | Purpose |
|--------|------|---------|---------|
| `ags-mcp-server` | Confidential | this server | authenticate to the introspection endpoint |
| `ags-mcp-client` | Public (PKCE) | MCP clients (Claude Desktop, etc.) | authorization-code + PKCE login to obtain tokens |

`ags-mcp-server` — Client authentication **ON**; Standard flow / Direct access grants **OFF**;
Service accounts **OFF**. Copy its secret into `AGS_MCP_CLIENT_SECRET`.

`ags-mcp-client` — Client authentication **OFF** (Public); Standard flow **ON**; set Valid
Redirect URIs to the MCP client's callback; enable PKCE (`S256`). Add an **Audience** protocol
mapper on its dedicated scope with *Included Client Audience* = `ags-mcp-server`, so issued tokens
carry `aud: ags-mcp-server` (matches `AGS_MCP_AUDIENCE` and authorizes introspection).

> Keycloak allows a client to introspect a token when the token's `aud` includes that client's id.
> The audience mapper above is what makes introspection succeed — no admin/`realm-management`
> roles are needed on the server client.

## MCP client configuration

Point the client at the server's `/mcp` endpoint and use the **public** client for OAuth:

```jsonc
{
  "mcpServers": {
    "ags-mcp-server": {
      "type": "http",
      "url": "https://ags-mcp-server.eit217.cn:8443/mcp",
      "oauth": {
        "clientId": "ags-mcp-client",
        "callbackPort": 8765
      }
    }
  }
}
```

## Docker

Build/pull the image, then run with configuration passed as environment variables. Terminate TLS
at a reverse proxy (recommended) or mount certs and set `AGS_MCP_TLS_CERT` / `AGS_MCP_TLS_KEY`.

```bash
docker run -d --name ags-mcp-server --restart unless-stopped \
  -p 8443:8443 \
  -e E2B_API_KEY=<e2b-api-key> \
  -e E2B_DOMAIN=ap-shanghai.tencentags.com \
  -e AGS_MCP_OIDC_ISSUER=https://keycloak.eit217.cn/realms/eit217 \
  -e AGS_MCP_RESOURCE_URL=https://ags-mcp-server.eit217.cn:8443/mcp \
  -e AGS_MCP_AUDIENCE=ags-mcp-server \
  -e AGS_MCP_CLIENT_ID=ags-mcp-server \
  -e AGS_MCP_CLIENT_SECRET=<keycloak-client-secret> \
  -e AGS_MCP_DATABASE_URL=postgresql://<user>:<password>@<host>:5432/agsmcp \
  -e AGS_MCP_HOST=0.0.0.0 \
  -e AGS_MCP_PORT=8443 \
  -e AGS_MCP_TLS_CERT=/certs/fullchain.pem \
  -e AGS_MCP_TLS_KEY=/certs/privkey.pem \
  -e AGS_MCP_SANDBOX_TEMPLATE=<sandbox-template> \
  -e AGS_MCP_SANDBOX_TIMEOUT_MS=300000 \
  -e EXPORT_PLAYWRIGHT_TOOLS=true \
  -e PLAYWRIGHT_MCP_CAPS=vision,pdf \
  -v /path/to/certs:/certs:ro \
  <registry>/ags-remote-mcp:<tag>
```

> Do **not** bake secrets into the image; pass them at runtime (`--env-file` / a secret store).
> When the Keycloak hostname resolves via a slow DNS in the container, pin it:
> `docker run --add-host keycloak.eit217.cn:<internal-ip> ...`.

## Upstream tracking

The browser tools come from `playwright-core` (pinned in `package.json`). To pick up upstream
changes, bump the `playwright-core` version and re-test — note `createConnection` /
`coreBundle` are internal Playwright APIs and may change between releases.

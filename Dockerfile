# syntax=docker/dockerfile:1
#
# Remote multi-user MCP server (Streamable HTTP + OAuth2 Resource Server + AgentSandbox).
# Wraps Playwright's built-in MCP (via playwright-core coreBundle) and injects per-user
# AgentSandbox browser contexts. The browser runs in the remote sandbox and is driven over
# CDP/HTTPS, so this image ships NO local browser binaries.

# ------------------------------
# Base: production node_modules
# ------------------------------
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN --mount=type=cache,target=/root/.npm,sharing=locked,id=npm-cache \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
  npm ci --omit=dev

# ------------------------------
# Builder: compile TypeScript -> lib/
# ------------------------------
FROM base AS builder
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN --mount=type=cache,target=/root/.npm,sharing=locked,id=npm-cache \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
  npm ci
COPY package.json package-lock.json tsconfig.json ./
COPY src src/
RUN npm run build

# ------------------------------
# Runtime
# ------------------------------
FROM base
ARG USERNAME=node
ENV NODE_ENV=production

# Container defaults — override at runtime as needed.
ENV AGS_MCP_HOST=0.0.0.0 \
    AGS_MCP_PORT=8931

# Common debugging tools: ps (procps), vim, curl, ss/ip (iproute2), dig/nslookup (dnsutils), less.
# Route apt through the Tencent Debian mirror (handles both deb822 and legacy sources).
RUN for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      [ -f "$f" ] && sed -i 's|deb.debian.org|mirrors.tencent.com|g; s|security.debian.org|mirrors.tencent.com|g' "$f"; \
    done; \
    apt-get update && apt-get install -y --no-install-recommends \
      procps vim curl iproute2 dnsutils less \
  && rm -rf /var/lib/apt/lists/*

RUN chown -R ${USERNAME}:${USERNAME} node_modules
USER ${USERNAME}

COPY --chown=${USERNAME}:${USERNAME} package.json ./
COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/lib /app/lib

EXPOSE 8931

# Configuration via environment variables at runtime:
#
#   Sandbox (required):
#     E2B_API_KEY                   AGS sandbox platform API key
#     E2B_DOMAIN                    AGS sandbox domain (optional)
#
#   Auth — Resource Server (required to enable auth):
#     AGS_MCP_OIDC_ISSUER           OIDC issuer URL, e.g. https://keycloak.example.com/realms/myrealm
#     AGS_MCP_RESOURCE_URL          Canonical URL of this resource server
#
#   Auth — Confidential Client (optional; enables RFC 7662 token introspection):
#     AGS_MCP_CLIENT_ID             Keycloak client_id (must have Client Authentication enabled)
#     AGS_MCP_CLIENT_SECRET         Matching client secret
#     Without these two, the server falls back to local JWKS signature verification.
#
#   Auth — fine-grained (optional):
#     AGS_MCP_AUDIENCE              Expected `aud` claim (defaults to AGS_MCP_RESOURCE_URL)
#     AGS_MCP_ALLOWED_AZP           Comma-separated allowlist of `azp` (client_id) values
#
#   Persistence (optional):
#     AGS_MCP_DATABASE_URL          PostgreSQL connection URL for sandbox mapping persistence
#
#   TLS (optional; prefer terminating at a reverse proxy):
#     AGS_MCP_TLS_CERT              Path to TLS certificate file inside the container
#     AGS_MCP_TLS_KEY               Path to TLS private key file inside the container
#
#   Sandbox tuning (optional):
#     AGS_MCP_SANDBOX_TEMPLATE      Sandbox template name (default: browser-v1)
#     AGS_MCP_SANDBOX_TIMEOUT_MS    Idle-before-hibernate timeout in ms (default: 300000)
#
# Do NOT bake secrets into the image; pass them with `docker run --env-file` / a secret store.
ENTRYPOINT ["node", "lib/cli.js"]

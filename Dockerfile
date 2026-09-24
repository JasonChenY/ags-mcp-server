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
#   E2B_API_KEY, E2B_DOMAIN                              (AGS sandbox platform credentials)
#   AGS_MCP_OIDC_ISSUER, AGS_MCP_RESOURCE_URL, AGS_MCP_AUDIENCE
#   AGS_MCP_ALLOWED_AZP                                  (optional client_id allowlist)
#   AGS_MCP_DATABASE_URL                                 (optional Postgres mapping persistence)
#   AGS_MCP_TLS_CERT / AGS_MCP_TLS_KEY                   (optional in-process HTTPS)
#   AGS_MCP_SANDBOX_TEMPLATE (default browser-v1), AGS_MCP_SANDBOX_TIMEOUT_MS (default 300000)
# Do NOT bake secrets into the image; pass them with `docker run --env-file` / a secret store.
ENTRYPOINT ["node", "lib/cli.js"]

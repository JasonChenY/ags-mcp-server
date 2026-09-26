/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createTokenVerifier } from './auth/tokenVerifier.js';
import { PROTECTED_RESOURCE_METADATA_PATH, protectedResourceMetadata, bearerChallenge } from './auth/resourceMetadata.js';
import { browserContextGetter } from './sandboxContext.js';
import { addSandboxTools } from './wrapServer.js';
import { createConnection } from './pwmcp.js';
import { startStagingReaper, cleanupSessionStaging } from './staging.js';
import { testDebug } from './log.js';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthConfig, AuthContext } from './auth/types.js';
import type { SandboxRegistry } from './sandbox/registry.js';

export type TlsOptions = { key: string | Buffer, cert: string | Buffer };

export type StartOptions = {
  host?: string;
  port: number;
  tls?: TlsOptions;
  auth?: AuthConfig;
  registry: SandboxRegistry;
  /** Passed through to Playwright's createConnection (browser comes from contextGetter). */
  mcpConfig?: unknown;
  /** When false, Playwright's browser_* tools are hidden (server only serves sandbox_* tools). Default true. */
  exportPlaywrightTools?: boolean;
};

const ANONYMOUS: AuthContext = { userId: 'default' };

async function createUserServer(options: StartOptions, authContext: AuthContext, sessionId: string): Promise<Server> {
  const server = await createConnection(options.mcpConfig, browserContextGetter(options.registry, authContext));
  addSandboxTools(server, options.registry, authContext, sessionId, options.exportPlaywrightTools ?? true);
  return server;
}

export async function startServer(options: StartOptions): Promise<void> {
  const { host, port, tls, auth } = options;
  if (auth && !tls)
    console.error('Warning: bearer auth is enabled over plain HTTP; ensure TLS is terminated by a trusted reverse proxy.');

  // Clear orphaned upload staging from a previous run, then reap stale dirs periodically.
  startStagingReaper(30 * 60 * 1000);

  const verify = auth ? await createTokenVerifier(auth) : undefined;

  if (!auth) {
    console.error('Auth: disabled (open mode — set AGS_MCP_OIDC_ISSUER + AGS_MCP_RESOURCE_URL to enable)');
  } else if (auth.clientId) {
    console.error(`Auth: confidential-client introspection  client_id=${auth.clientId}  issuer=${auth.issuer}`);
  } else {
    console.error(`Auth: JWKS local verification  issuer=${auth.issuer}`);
  }

  const caps = (options.mcpConfig as any)?.capabilities as string[] | undefined;
  if (caps?.length)
    console.error(`Playwright caps: ${caps.join(', ')}`);

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer: http.Server = tls ? https.createServer({ key: tls.key, cert: tls.cert }) : http.createServer();

  httpServer.on('request', async (req, res) => {
    const url = new URL(`http://localhost${req.url}`);

    // Unauthenticated discovery endpoint (RFC 9728).
    if (auth && url.pathname === PROTECTED_RESOURCE_METADATA_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(protectedResourceMetadata(auth)));
      return;
    }

    let authContext: AuthContext = ANONYMOUS;
    if (verify) {
      const metadataUrl = externalBaseUrl(req, httpServer) + PROTECTED_RESOURCE_METADATA_PATH;
      const bearer = extractBearer(req);
      if (!bearer) {
        res.writeHead(401, { 'WWW-Authenticate': bearerChallenge(metadataUrl) });
        res.end('Unauthorized');
        return;
      }
      try {
        authContext = await verify(bearer);
      } catch (error) {
        res.writeHead(401, { 'WWW-Authenticate': bearerChallenge(metadataUrl, 'invalid_token', String((error as Error).message)) });
        res.end('Unauthorized');
        return;
      }
    }

    await handleStreamable(options, req, res, sessions, authContext);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const scheme = tls ? 'https' : 'http';
  console.error(`AGS remote MCP server listening on ${scheme}://${host ?? 'localhost'}:${port}/mcp`);
}

async function handleStreamable(options: StartOptions, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>, authContext: AuthContext) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async (sid: string) => {
        testDebug(`create session ${sid} for ${authContext.username ?? authContext.userId}`);
        const server = await createUserServer(options, authContext, sid);
        await server.connect(transport);
        sessions.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        void cleanupSessionStaging(transport.sessionId);
      }
    };
    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}

function extractBearer(req: http.IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^Bearer (.+)$/i.exec(value) : null;
  return match?.[1];
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function externalBaseUrl(req: http.IncomingMessage, server: http.Server): string {
  const proto = firstHeader(req.headers['x-forwarded-proto']) ?? (server instanceof https.Server ? 'https' : 'http');
  const host = firstHeader(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import fs from 'fs';

import { resolveAuthConfig } from './auth/config.js';
import { SandboxRegistry } from './sandbox/registry.js';
import { PostgresSandboxStore } from './sandbox/store.js';
import { startServer } from './httpServer.js';
import { OUTPUT_DIR } from './staging.js';

import type { TlsOptions } from './httpServer.js';

function loadTls(): TlsOptions | undefined {
  const certPath = process.env.AGS_MCP_TLS_CERT;
  const keyPath = process.env.AGS_MCP_TLS_KEY;
  if (!certPath && !keyPath)
    return undefined;
  if (!certPath || !keyPath)
    throw new Error('Both AGS_MCP_TLS_CERT and AGS_MCP_TLS_KEY are required to serve HTTPS.');
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

async function main() {
  const port = Number(process.env.AGS_MCP_PORT ?? '8931');
  const host = process.env.AGS_MCP_HOST ?? '0.0.0.0';
  const databaseUrl = process.env.AGS_MCP_DATABASE_URL ?? process.env.DATABASE_URL;

  const registry = new SandboxRegistry({
    template: process.env.AGS_MCP_SANDBOX_TEMPLATE ?? 'browser-v1',
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: Number(process.env.AGS_MCP_SANDBOX_TIMEOUT_MS ?? String(5 * 60 * 1000)),
    store: databaseUrl ? new PostgresSandboxStore(databaseUrl) : undefined,
  });

  await startServer({
    host,
    port,
    tls: loadTls(),
    auth: resolveAuthConfig({}),
    registry,
    // outputDir doubles as Playwright's file-access allowed root; we stage uploads under it.
    mcpConfig: { outputDir: OUTPUT_DIR },
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

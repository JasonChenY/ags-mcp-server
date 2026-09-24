/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 *
 * Thin bridge to Playwright's built-in MCP implementation. Since playwright-mcp v0.0.37
 * the browser MCP server lives inside playwright-core (`coreBundle`); this fork consumes
 * its `createConnection(config, contextGetter)` factory rather than re-implementing it.
 */

import { createRequire } from 'module';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { BrowserContext } from 'playwright-core';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tools } = require('playwright-core/lib/coreBundle');

export type ContextGetter = () => Promise<BrowserContext>;

/** createConnection(config?, contextGetter?) => MCP Server. Config is passed through opaquely. */
export const createConnection: (config?: unknown, contextGetter?: ContextGetter) => Promise<Server> =
  tools.createConnection;

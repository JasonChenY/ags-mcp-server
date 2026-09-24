/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { SANDBOX_TOOL_DEFS, handleSandboxTool } from './sandboxTools.js';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { SandboxRegistry } from './sandbox/registry.js';
import type { AuthContext } from './auth/types.js';

type Handler = (req: any, extra: any) => Promise<any>;

/**
 * Merge our sandbox-management tools into the tool set of a Server produced by Playwright's
 * `createConnection`. We capture the core `tools/list` + `tools/call` handlers and re-register
 * wrappers: list appends our tool defs; call routes sandbox tools to us, everything else to core.
 */
export function addSandboxTools(server: Server, registry: SandboxRegistry, authContext: AuthContext): void {
  const handlers = (server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const coreList = handlers.get('tools/list');
  const coreCall = handlers.get('tools/call');

  server.setRequestHandler(ListToolsRequestSchema, async (req: any, extra: any) => {
    const res = coreList ? await coreList(req, extra) : { tools: [] };
    return { ...res, tools: [...(res.tools ?? []), ...SANDBOX_TOOL_DEFS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any, extra: any) => {
    const handled = await handleSandboxTool(req.params?.name, registry, authContext);
    if (handled.handled)
      return handled.result;
    if (coreCall)
      return coreCall(req, extra);
    throw new Error(`Unknown tool: ${req.params?.name}`);
  });
}

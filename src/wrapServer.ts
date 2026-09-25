/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { SANDBOX_TOOL_DEFS, handleSandboxTool } from './sandboxTools.js';
import { stageFile, unstage } from './staging.js';
import { testDebug } from './log.js';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { SandboxRegistry } from './sandbox/registry.js';
import type { AuthContext } from './auth/types.js';

type Handler = (req: any, extra: any) => Promise<any>;

// Remote clients can't reference server file paths, so we replace core's
// browser_file_upload({paths}) schema with an inline-content one ({files}).
const UPLOAD_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: 'Files to upload to the page\'s file chooser, provided inline.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name shown to the page.' },
          content: { type: 'string', description: 'File content (UTF-8 text, or base64 when encoding=base64).' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding of content; use base64 for binary. Default utf8.' },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['files'],
  additionalProperties: false,
};

/**
 * Wrap a Server produced by Playwright's `createConnection`:
 * - merge our sandbox_* tools into the tool set;
 * - override `browser_file_upload` so clients pass file bytes inline — we stage them on the
 *   server (where Playwright reads uploads from), delegate to core with the staged paths, then
 *   delete the staged files once core has consumed them.
 */
export function addSandboxTools(server: Server, registry: SandboxRegistry, authContext: AuthContext, sessionId: string): void {
  const handlers = (server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const coreList = handlers.get('tools/list');
  const coreCall = handlers.get('tools/call');

  server.setRequestHandler(ListToolsRequestSchema, async (req: any, extra: any) => {
    const res = coreList ? await coreList(req, extra) : { tools: [] };
    const tools = (res.tools ?? []).map((t: any) => t.name === 'browser_file_upload'
      ? { ...t, description: 'Upload files to the page\'s file chooser. Provide file bytes inline via `files`; they are delivered to the browser. Trigger the file chooser first (e.g. click the upload control).', inputSchema: UPLOAD_SCHEMA }
      : t);
    return { ...res, tools: [...tools, ...SANDBOX_TOOL_DEFS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any, extra: any) => {
    const name = req.params?.name;

    if (name === 'browser_file_upload') {
      const files = Array.isArray(req.params?.arguments?.files) ? req.params.arguments.files : [];
      if (!files.length) {
        return {
          content: [{ type: 'text', text: 'Error: browser_file_upload requires inline file bytes, e.g. files=[{ name, content, encoding: "utf8"|"base64" }]. Remote/server file PATHS are not accepted — read the file and pass its content (use base64 for binary).' }],
          isError: true,
        };
      }
      const staged: string[] = [];
      for (const f of files) {
        const encoding = f?.encoding === 'base64' ? 'base64' : 'utf8';
        const buf = Buffer.from(String(f?.content ?? ''), encoding);
        staged.push(await stageFile(sessionId, String(f?.name ?? 'upload.bin'), buf));
      }
      testDebug(`browser_file_upload: staged ${staged.length} file(s) for ${authContext.userId}`);
      const coreReq = { ...req, params: { ...req.params, arguments: { paths: staged } } };
      try {
        return await coreCall!(coreReq, extra);
      } finally {
        void unstage(staged);
      }
    }

    const handled = await handleSandboxTool(name, req.params?.arguments, registry, authContext);
    if (handled.handled)
      return handled.result;
    if (coreCall)
      return coreCall(req, extra);
    throw new Error(`Unknown tool: ${name}`);
  });
}

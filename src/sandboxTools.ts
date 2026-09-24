/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { testDebug } from './log.js';

import type { SandboxRegistry } from './sandbox/registry.js';
import type { AuthContext } from './auth/types.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

/** MCP tool definitions merged into Playwright's core tool set for sandbox lifecycle control. */
export const SANDBOX_TOOL_DEFS = [
  {
    name: 'browser_sandbox_pause',
    description: 'Hibernate (pause) the current user\'s browser sandbox to save resources. State is preserved and resumed automatically on the next browser action. Idle sandboxes also hibernate automatically.',
    inputSchema: NO_ARGS,
    annotations: { title: 'Hibernate browser sandbox', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'browser_sandbox_delete',
    description: 'Permanently delete the current user\'s browser sandbox. A fresh one is created on the next browser action.',
    inputSchema: NO_ARGS,
    annotations: { title: 'Delete browser sandbox', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'browser_sandbox_vnc_url',
    description: 'Get a live noVNC URL (includes a sandbox access token) to watch and interact with the current user\'s sandbox browser in a web browser. Creates/resumes the sandbox if needed.',
    inputSchema: NO_ARGS,
    annotations: { title: 'Get sandbox noVNC URL', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
];

type CallResult = { content: { type: 'text', text: string }[] };

/** Handle a sandbox-management tool call. Returns `{handled:false}` for non-sandbox tools. */
export async function handleSandboxTool(name: string | undefined, registry: SandboxRegistry, authContext: AuthContext): Promise<{ handled: boolean, result?: CallResult }> {
  if (name === 'browser_sandbox_pause') {
    testDebug(`tool browser_sandbox_pause for ${authContext.userId}`);
    const paused = await registry.pause(authContext.userId);
    return { handled: true, result: { content: [{ type: 'text', text: paused ? 'Sandbox hibernated; it will resume automatically on the next browser action.' : 'No active sandbox to hibernate.' }] } };
  }
  if (name === 'browser_sandbox_delete') {
    testDebug(`tool browser_sandbox_delete for ${authContext.userId}`);
    await registry.kill(authContext.userId);
    return { handled: true, result: { content: [{ type: 'text', text: 'Sandbox deleted. A new sandbox will be created on the next browser action.' }] } };
  }
  if (name === 'browser_sandbox_vnc_url') {
    testDebug(`tool browser_sandbox_vnc_url for ${authContext.userId}`);
    const username = authContext.username ?? authContext.userId;
    const sandbox = await registry.acquire(authContext.userId, { userId: username, sub: authContext.userId });
    const token = (sandbox as unknown as { envdAccessToken?: string }).envdAccessToken ?? '';
    const url = `https://${sandbox.getHost(9000)}/novnc/vnc.html?access_token=${token}`;
    return { handled: true, result: { content: [{ type: 'text', text: url }] } };
  }
  return { handled: false };
}

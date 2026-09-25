/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { testDebug } from './log.js';

import type { Sandbox } from '@e2b/code-interpreter';
import type { SandboxRegistry } from './sandbox/registry.js';
import type { AuthContext } from './auth/types.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;
const PATH_ONLY = {
  type: 'object',
  properties: { path: { type: 'string', description: 'Absolute path inside the sandbox.' } },
  required: ['path'],
  additionalProperties: false,
} as const;

/**
 * Web surfaces the sandbox exposes on port 9000, each authenticated via an `access_token`
 * query param. Add a new entry here to expose another surface — no tool changes needed.
 */
const SANDBOX_SURFACES: { key: string, label: string, path: string }[] = [
  { key: 'browser', label: 'Browser (noVNC)', path: 'novnc/vnc.html' },
  { key: 'terminal', label: 'Terminal (ttyd)', path: 'ttyd/' },
];

/** MCP tool definitions merged into Playwright's core tool set for sandbox management. */
export const SANDBOX_TOOL_DEFS = [
  {
    name: 'sandbox_pause',
    description: 'Hibernate (pause) the current user\'s browser sandbox to save resources. State is preserved and resumed automatically on the next browser action. Idle sandboxes also hibernate automatically.',
    inputSchema: NO_ARGS,
    annotations: { title: 'Hibernate sandbox', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'sandbox_delete',
    description: 'Permanently delete the current user\'s browser sandbox. A fresh one is created on the next browser action.',
    inputSchema: NO_ARGS,
    annotations: { title: 'Delete sandbox', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'sandbox_access_urls',
    description: 'Get live web URLs (each carrying a sandbox access token) to directly access the current user\'s sandbox: watch/control the browser via noVNC, and open a shell via ttyd. Creates/resumes the sandbox if needed.',
    inputSchema: NO_ARGS,
    annotations: { title: 'Get sandbox access URLs', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'sandbox_upload_file',
    description: 'Upload a file into the current user\'s sandbox (client → sandbox). Provide `content` as UTF-8 text or base64 (set `encoding`). Creates parent directories as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute destination path inside the sandbox.' },
        content: { type: 'string', description: 'File content (UTF-8 text, or base64 when encoding=base64).' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding of `content`. Default utf8.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    annotations: { title: 'Upload file to sandbox', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'sandbox_download_file',
    description: 'Download a file from the current user\'s sandbox (sandbox → client). Returns UTF-8 text, or base64 when encoding=base64 (use base64 for binary files).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file inside the sandbox.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Return encoding. Default utf8.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { title: 'Download file from sandbox', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'sandbox_list_files',
    description: 'List entries of a directory inside the current user\'s sandbox.',
    inputSchema: PATH_ONLY,
    annotations: { title: 'List sandbox files', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'sandbox_run_command',
    description: 'Run a shell command inside the current user\'s sandbox (not the browser). Creates/resumes the sandbox if needed. Returns stdout/stderr/exitCode. By default runs synchronously to completion; set background=true to start it in the background (returns a pid you can wait on later).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        background: { type: 'boolean', description: 'Run in background and return immediately (default false).' },
        cwd: { type: 'string', description: 'Working directory (default sandbox user home).' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (synchronous mode only).' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: { title: 'Run command in sandbox', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

type Args = Record<string, unknown> | undefined;
type CallResult = { content: { type: 'text', text: string }[], isError?: boolean };

function text(s: string, isError = false): CallResult {
  return { content: [{ type: 'text', text: s }], isError: isError || undefined } as CallResult;
}

function acquireForUser(registry: SandboxRegistry, authContext: AuthContext): Promise<Sandbox> {
  const username = authContext.username ?? authContext.userId;
  return registry.acquire(authContext.userId, { userId: username, sub: authContext.userId });
}

/** Handle a sandbox-management tool call. Returns `{handled:false}` for non-sandbox tools. */
export async function handleSandboxTool(name: string | undefined, args: Args, registry: SandboxRegistry, authContext: AuthContext): Promise<{ handled: boolean, result?: CallResult }> {
  if (name === 'sandbox_pause') {
    testDebug(`tool sandbox_pause for ${authContext.userId}`);
    const paused = await registry.pause(authContext.userId);
    return { handled: true, result: text(paused ? 'Sandbox hibernated; it will resume automatically on the next browser action.' : 'No active sandbox to hibernate.') };
  }

  if (name === 'sandbox_delete') {
    testDebug(`tool sandbox_delete for ${authContext.userId}`);
    await registry.kill(authContext.userId);
    return { handled: true, result: text('Sandbox deleted. A new sandbox will be created on the next browser action.') };
  }

  if (name === 'sandbox_access_urls') {
    testDebug(`tool sandbox_access_urls for ${authContext.userId}`);
    const sandbox = await acquireForUser(registry, authContext);
    const host = sandbox.getHost(9000);
    const token = (sandbox as unknown as { envdAccessToken?: string }).envdAccessToken ?? '';
    const lines = SANDBOX_SURFACES.map(s => `${s.label}: https://${host}/${s.path}?access_token=${token}`);
    return { handled: true, result: text(lines.join('\n')) };
  }

  if (name === 'sandbox_upload_file') {
    const path = String(args?.path ?? '');
    const content = String(args?.content ?? '');
    const encoding = args?.encoding === 'base64' ? 'base64' : 'utf8';
    if (!path)
      return { handled: true, result: text('Error: `path` is required.', true) };
    testDebug(`tool sandbox_upload_file ${path} (${encoding}) for ${authContext.userId}`);
    const sandbox = await acquireForUser(registry, authContext);
    if (encoding === 'base64') {
      const buf = Buffer.from(content, 'base64');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      await sandbox.files.write(path, ab);
      return { handled: true, result: text(`Uploaded ${buf.byteLength} bytes to ${path}.`) };
    }
    await sandbox.files.write(path, content);
    return { handled: true, result: text(`Uploaded ${Buffer.byteLength(content, 'utf8')} bytes to ${path}.`) };
  }

  if (name === 'sandbox_download_file') {
    const path = String(args?.path ?? '');
    const encoding = args?.encoding === 'base64' ? 'base64' : 'utf8';
    if (!path)
      return { handled: true, result: text('Error: `path` is required.', true) };
    testDebug(`tool sandbox_download_file ${path} (${encoding}) for ${authContext.userId}`);
    const sandbox = await acquireForUser(registry, authContext);
    if (encoding === 'base64') {
      const bytes = await sandbox.files.read(path, { format: 'bytes' });
      return { handled: true, result: text(Buffer.from(bytes).toString('base64')) };
    }
    const content = await sandbox.files.read(path, { format: 'text' });
    return { handled: true, result: text(content) };
  }

  if (name === 'sandbox_list_files') {
    const path = String(args?.path ?? '');
    if (!path)
      return { handled: true, result: text('Error: `path` is required.', true) };
    testDebug(`tool sandbox_list_files ${path} for ${authContext.userId}`);
    const sandbox = await acquireForUser(registry, authContext);
    const entries = await sandbox.files.list(path);
    const rows = entries.map(e => ({ name: e.name, type: e.type, size: e.size }));
    return { handled: true, result: text(JSON.stringify(rows, null, 2)) };
  }

  if (name === 'sandbox_run_command') {
    const command = String(args?.command ?? '');
    if (!command)
      return { handled: true, result: text('Error: `command` is required.', true) };
    const background = args?.background === true;
    const cwd = args?.cwd ? String(args.cwd) : undefined;
    const timeoutMs = args?.timeoutMs ? Number(args.timeoutMs) : undefined;
    testDebug(`tool sandbox_run_command (bg=${background}) for ${authContext.userId}: ${command.slice(0, 120)}`);
    const sandbox = await acquireForUser(registry, authContext);
    const opts = { background, cwd, timeoutMs } as Record<string, unknown>;
    try {
      if (background) {
        const handle = await sandbox.commands.run(command, opts as any);
        const pid = (handle as any).pid;
        return { handled: true, result: text(JSON.stringify({ background: true, pid })) };
      }
      const result = await sandbox.commands.run(command, opts as any);
      return { handled: true, result: text(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.error ?? null }, null, 2)) };
    } catch (error: any) {
      // Non-zero exit throws CommandExitError carrying the result — surface it, not a failure.
      if (typeof error?.exitCode === 'number' && typeof error?.stdout === 'string') {
        return { handled: true, result: text(JSON.stringify({ exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr, error: error.error ?? String(error.message ?? '') }, null, 2)) };
      }
      return { handled: true, result: text(`Error running command: ${String(error?.message ?? error)}`, true) };
    }
  }

  return { handled: false };
}

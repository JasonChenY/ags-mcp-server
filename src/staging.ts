/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 *
 * Staging area on the MCP server's local filesystem for files a client wants to upload
 * through the browser. Playwright's `browser_file_upload` reads paths from the Playwright
 * host (this server), so client bytes must land here first. Directories are created lazily
 * (only when a stage actually happens) and cleaned up on session close / by a TTL reaper.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { testDebug } from './log.js';

/**
 * Playwright's file-access guard only allows files inside `config.outputDir` (or the client
 * workspace). We set createConnection's `outputDir` to OUTPUT_DIR and stage uploads under it,
 * so `browser_file_upload` accepts the staged paths. Keep both in sync via this exported const.
 */
export const OUTPUT_DIR = process.env.AGS_MCP_OUTPUT_DIR ?? path.join(os.tmpdir(), 'ags-mcp');
const STAGING_ROOT = path.join(OUTPUT_DIR, 'uploads');

function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  return path.join(STAGING_ROOT, safe);
}

/** Write `data` to a per-session staging dir (created lazily) and return the absolute path. */
export async function stageFile(sessionId: string, name: string, data: Buffer): Promise<string> {
  const dir = sessionDir(sessionId);
  await fs.promises.mkdir(dir, { recursive: true });
  const safeName = path.basename(name) || 'upload.bin';
  const filePath = path.join(dir, `${crypto.randomUUID()}-${safeName}`);
  await fs.promises.writeFile(filePath, data);
  testDebug(`staged ${data.byteLength} bytes at ${filePath}`);
  return filePath;
}

/** Remove specific staged files (best-effort). Called right after core consumes them. */
export async function unstage(paths: string[]): Promise<void> {
  await Promise.all(paths.map(p => fs.promises.rm(p, { force: true }).catch(() => {})));
}

/** Remove a session's staging dir. No-op if it was never created. */
export async function cleanupSessionStaging(sessionId: string): Promise<void> {
  await fs.promises.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

/**
 * Clear any orphaned staging dirs from a previous run, then periodically reap session dirs
 * older than `ttlMs` (safety net for sessions that never fired onclose, e.g. after a crash).
 */
export function startStagingReaper(ttlMs: number): void {
  void fs.promises.rm(STAGING_ROOT, { recursive: true, force: true }).catch(() => {});
  const timer = setInterval(() => void reap(ttlMs), Math.min(ttlMs, 5 * 60 * 1000));
  timer.unref();
}

async function reap(ttlMs: number): Promise<void> {
  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(STAGING_ROOT, { withFileTypes: true });
  } catch {
    return; // root doesn't exist yet — nothing staged
  }
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue;
    const dir = path.join(STAGING_ROOT, entry.name);
    try {
      const stat = await fs.promises.stat(dir);
      if (now - stat.mtimeMs > ttlMs) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        testDebug(`reaped stale staging dir ${entry.name}`);
      }
    } catch {
      // ignore
    }
  }
}

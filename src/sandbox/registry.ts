/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { Sandbox } from '@e2b/code-interpreter';

import { testDebug } from '../log.js';

import type { SandboxStore } from './store.js';

export type SandboxRegistryOptions = {
  template: string;
  apiKey?: string;
  timeoutMs: number;
  store?: SandboxStore;
};

type Entry = { sandboxPromise: Promise<Sandbox>, sandboxId?: string, lastUsed: number };

/**
 * Process-wide registry of AgentSandbox instances keyed by a stable tenant id (token `sub`).
 * Idle sandboxes auto-hibernate (autoPause) and are resumed by id on next acquire.
 */
export class SandboxRegistry {
  private _entries = new Map<string, Entry>();
  private _options: SandboxRegistryOptions;

  constructor(options: SandboxRegistryOptions) {
    this._options = options;
  }

  async acquire(key: string, metadata: Record<string, string>): Promise<Sandbox> {
    const now = Date.now();
    const existing = this._entries.get(key);
    const store = this._options.store;
    if (existing && now - existing.lastUsed <= this._options.timeoutMs) {
      try {
        const sandbox = await existing.sandboxPromise;
        await sandbox.setTimeout(this._options.timeoutMs);
        existing.lastUsed = now;
        testDebug(`reuse sandbox ${sandbox.sandboxId} for ${key}`);
        await store?.touch(sandbox.sandboxId);
        return sandbox;
      } catch (error) {
        testDebug(`reuse failed for ${key}: ${String(error)}`);
      }
    }
    let sandboxId = existing?.sandboxId;
    if (!sandboxId && store)
      sandboxId = (await store.getActive(key))?.sandboxId;
    if (sandboxId) {
      try {
        const sandbox = await Sandbox.connect(sandboxId, {
          apiKey: this._options.apiKey,
          timeoutMs: this._options.timeoutMs,
        });
        this._entries.set(key, { sandboxPromise: Promise.resolve(sandbox), sandboxId: sandbox.sandboxId, lastUsed: now });
        await store?.setState(sandbox.sandboxId, 'running');
        testDebug(`resumed sandbox ${sandbox.sandboxId} for ${key}`);
        return sandbox;
      } catch (error) {
        testDebug(`resume failed for ${key} (${sandboxId}), recreating: ${String(error)}`);
        this._entries.delete(key);
        await store?.setState(sandboxId, 'deleted');
      }
    }
    return this._create(key, metadata, now);
  }

  private _create(key: string, metadata: Record<string, string>, now: number): Promise<Sandbox> {
    testDebug(`create sandbox for ${key} (template ${this._options.template}, metadata ${JSON.stringify(metadata)})`);
    // lifecycle.onTimeout='pause' => hibernate (snapshot) instead of kill when idle;
    // autoResume => wake on inbound traffic. Next acquire also resumes explicitly via connect().
    const sandboxPromise = Sandbox.create(this._options.template, {
      apiKey: this._options.apiKey,
      metadata,
      timeoutMs: this._options.timeoutMs,
      lifecycle: { onTimeout: 'pause', autoResume: true },
    });
    const entry: Entry = { sandboxPromise, lastUsed: now };
    this._entries.set(key, entry);
    const store = this._options.store;
    void sandboxPromise.then(sandbox => {
      entry.sandboxId = sandbox.sandboxId;
      if (store)
        void store.insert({ sandboxId: sandbox.sandboxId, userId: key, username: metadata.userId }).catch(error => testDebug(`store insert failed for ${key}: ${String(error)}`));
    }).catch(() => {
      if (this._entries.get(key) === entry)
        this._entries.delete(key);
    });
    return sandboxPromise;
  }

  /** Hibernate a user's sandbox now; state preserved, resumed on next acquire. */
  async pause(userId: string): Promise<boolean> {
    const entry = this._entries.get(userId);
    const sandboxId = entry?.sandboxId ?? (await this._options.store?.getActive(userId))?.sandboxId;
    if (!sandboxId)
      return false;
    try {
      testDebug(`pause sandbox ${sandboxId} for user ${userId}`);
      const paused = await Sandbox.pause(sandboxId, { apiKey: this._options.apiKey });
      await this._options.store?.setState(sandboxId, 'paused');
      if (entry)
        entry.lastUsed = 0;
      return paused;
    } catch (error) {
      testDebug(`pause failed for user ${userId}: ${String(error)}`);
      return false;
    }
  }

  /** Permanently delete a user's sandbox; the mapping row is retained as state='deleted'. */
  async kill(userId: string): Promise<void> {
    const entry = this._entries.get(userId);
    this._entries.delete(userId);
    const sandboxId = entry?.sandboxId ?? (await entry?.sandboxPromise.catch(() => undefined))?.sandboxId ?? (await this._options.store?.getActive(userId))?.sandboxId;
    if (!sandboxId)
      return;
    try {
      testDebug(`kill sandbox ${sandboxId} for user ${userId}`);
      await Sandbox.kill(sandboxId, { apiKey: this._options.apiKey });
    } catch {
      // best-effort
    }
    try {
      await this._options.store?.setState(sandboxId, 'deleted');
    } catch {
      // best-effort
    }
  }
}

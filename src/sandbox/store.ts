/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import pg from 'pg';

import { testDebug } from '../log.js';

export type SandboxState = 'running' | 'paused' | 'deleted';

export type SandboxRecord = {
  sandboxId: string;
  userId: string;
  username?: string;
  state: SandboxState;
};

/**
 * Durable record of every sandbox and its current state so sandboxes survive server
 * restarts and released ones stay on record. Keyed by `sandbox_id`; a user may have
 * many rows over time but at most one non-`deleted` row at any moment.
 */
export interface SandboxStore {
  getActive(userId: string): Promise<SandboxRecord | undefined>;
  insert(record: { sandboxId: string, userId: string, username?: string }): Promise<void>;
  setState(sandboxId: string, state: SandboxState): Promise<void>;
  touch(sandboxId: string): Promise<void>;
}

export class PostgresSandboxStore implements SandboxStore {
  private _pool: pg.Pool;
  private _ready: Promise<void> | undefined;

  constructor(connectionString: string) {
    this._pool = new pg.Pool({ connectionString });
  }

  private _init(): Promise<void> {
    if (!this._ready) {
      this._ready = this._pool.query(`
        CREATE TABLE IF NOT EXISTS sandboxes (
          sandbox_id   text PRIMARY KEY,
          user_id      text NOT NULL,
          username     text,
          state        text NOT NULL DEFAULT 'running',
          created_at   timestamptz NOT NULL DEFAULT now(),
          last_used_at timestamptz NOT NULL DEFAULT now(),
          released_at  timestamptz
        );
        CREATE INDEX IF NOT EXISTS sandboxes_user_active_idx
          ON sandboxes (user_id, last_used_at DESC) WHERE state <> 'deleted';
      `).then(() => { testDebug('sandboxes table ready'); });
    }
    return this._ready;
  }

  async getActive(userId: string): Promise<SandboxRecord | undefined> {
    await this._init();
    const result = await this._pool.query(`
      SELECT sandbox_id, user_id, username, state FROM sandboxes
      WHERE user_id = $1 AND state <> 'deleted'
      ORDER BY last_used_at DESC LIMIT 1
    `, [userId]);
    const row = result.rows[0];
    if (!row)
      return undefined;
    return { sandboxId: row.sandbox_id, userId: row.user_id, username: row.username ?? undefined, state: row.state };
  }

  async insert(record: { sandboxId: string, userId: string, username?: string }): Promise<void> {
    await this._init();
    await this._pool.query(`
      INSERT INTO sandboxes (sandbox_id, user_id, username, state, last_used_at)
      VALUES ($1, $2, $3, 'running', now())
      ON CONFLICT (sandbox_id)
      DO UPDATE SET state = 'running', last_used_at = now(), released_at = NULL
    `, [record.sandboxId, record.userId, record.username ?? null]);
  }

  async setState(sandboxId: string, state: SandboxState): Promise<void> {
    await this._init();
    await this._pool.query(`
      UPDATE sandboxes
      SET state = $2,
          last_used_at = now(),
          released_at = CASE WHEN $2 = 'deleted' THEN now() ELSE released_at END
      WHERE sandbox_id = $1
    `, [sandboxId, state]);
  }

  async touch(sandboxId: string): Promise<void> {
    await this._init();
    await this._pool.query('UPDATE sandboxes SET last_used_at = now() WHERE sandbox_id = $1', [sandboxId]);
  }
}

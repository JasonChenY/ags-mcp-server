/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { chromium } from 'playwright-core';

import { testDebug } from './log.js';

import type { BrowserContext } from 'playwright-core';
import type { SandboxRegistry } from './sandbox/registry.js';
import type { AuthContext } from './auth/types.js';

/**
 * Build the `contextGetter` handed to Playwright's `createConnection`: acquire (or resume)
 * the caller's AgentSandbox and return a Playwright BrowserContext connected to it over CDP.
 * Sandbox is keyed by the stable `sub`; metadata.userId is the readable preferred_username.
 */
export function browserContextGetter(registry: SandboxRegistry, authContext: AuthContext): () => Promise<BrowserContext> {
  return async () => {
    const userId = authContext.userId;
    const username = authContext.username ?? userId;
    const sandbox = await registry.acquire(userId, { userId: username, sub: userId });
    const cdpUrl = `https://${sandbox.getHost(9000)}/cdp`;
    const accessToken = (sandbox as unknown as { envdAccessToken?: string }).envdAccessToken;
    testDebug(`connect CDP ${cdpUrl} for ${username} (${userId})`);
    const browser = await chromium.connectOverCDP(cdpUrl, {
      headers: { 'X-Access-Token': accessToken ?? '' },
    });
    return browser.contexts()[0];
  };
}

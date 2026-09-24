/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import type { AuthConfig } from './types.js';

export type AuthCLIOptions = {
  oidcIssuer?: string;
  resourceUrl?: string;
  audience?: string;
  allowedAzp?: string[];
};

function commaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Resolve Resource Server auth config from options and environment.
 * Returns `undefined` when unconfigured; throws if only one of issuer/resource is given.
 */
export function resolveAuthConfig(options: AuthCLIOptions): AuthConfig | undefined {
  const issuer = options.oidcIssuer ?? process.env.AGS_MCP_OIDC_ISSUER;
  const resource = options.resourceUrl ?? process.env.AGS_MCP_RESOURCE_URL;

  if (!issuer && !resource)
    return undefined;
  if (!issuer || !resource)
    throw new Error('Both an OIDC issuer (--oidc-issuer) and a resource URL (--resource-url) are required to enable auth.');

  return {
    issuer,
    resource,
    audience: options.audience ?? process.env.AGS_MCP_AUDIENCE,
    jwksUri: process.env.AGS_MCP_JWKS_URI,
    allowedAzp: options.allowedAzp ?? commaSeparatedList(process.env.AGS_MCP_ALLOWED_AZP),
  };
}

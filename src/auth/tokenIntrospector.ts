/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import type { AuthConfig, AuthContext } from './types.js';

export type TokenIntrospector = (bearer: string) => Promise<AuthContext>;

/**
 * Build a Confidential-Client token introspector (RFC 7662).
 * The introspection endpoint is discovered from the OIDC Discovery document
 * (RFC 8414) at `${issuer}/.well-known/openid-configuration` rather than
 * hard-coded, so this works with any standards-compliant authorization server.
 */
export async function createTokenIntrospector(config: AuthConfig): Promise<TokenIntrospector> {
  if (!config.clientId || !config.clientSecret)
    throw new Error('clientId and clientSecret are required for token introspection.');

  const endpoint = await discoverIntrospectionEndpoint(config.issuer);
  const allowedAzp = config.allowedAzp?.length ? new Set(config.allowedAzp) : undefined;

  // Pre-encode credentials once; value never changes.
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const authHeader = `Basic ${credentials}`;

  return async (bearer: string): Promise<AuthContext> => {
    // RFC 7662: send client credentials via Basic auth header AND in the POST body.
    // Keycloak accepts both; including them in the body improves compatibility with
    // Keycloak configurations that enforce client_secret_post authentication.
    const body = new URLSearchParams({
      token: bearer,
      token_type_hint: 'access_token',
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
    });

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new Error(`Introspection endpoint unreachable: ${(err as Error).message}`);
    }

    if (!res.ok) {
      // Surface Keycloak's own error description to make misconfiguration diagnosable.
      let detail = '';
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (errBody.error_description)
          detail = `: ${errBody.error_description}`;
        else if (errBody.error)
          detail = `: ${errBody.error}`;
      } catch { /* ignore parse failure, fall through to generic message */ }
      throw new Error(`Introspection endpoint returned HTTP ${res.status}${detail}`);
    }

    const payload = await res.json() as Record<string, unknown>;

    if (!payload.active)
      throw new Error('token is inactive or revoked');

    // Enforce issuer when present in the response (Keycloak always includes it).
    if (typeof payload.iss === 'string' && payload.iss !== config.issuer)
      throw new Error(`unexpected issuer in introspection response: ${payload.iss}`);

    // Enforce audience when configured.
    const expectedAudience = config.audience ?? config.resource;
    if (expectedAudience) {
      const aud = payload.aud;
      const audiences = Array.isArray(aud) ? aud as string[] : [aud as string];
      if (!audiences.includes(expectedAudience))
        throw new Error(`token audience does not include expected value: ${expectedAudience}`);
    }

    if (!payload.sub)
      throw new Error('introspection response missing sub');

    if (allowedAzp && typeof payload.azp === 'string' && !allowedAzp.has(payload.azp))
      throw new Error(`azp not allowed: ${payload.azp}`);

    const username = typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;
    return { userId: payload.sub as string, username };
  };
}

/**
 * Fetch `${issuer}/.well-known/openid-configuration` (RFC 8414) and return the
 * `introspection_endpoint` field. Fails fast at startup if the issuer is unreachable
 * or does not advertise an introspection endpoint.
 */
async function discoverIntrospectionEndpoint(issuer: string): Promise<string> {
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(discoveryUrl);
  } catch (err) {
    throw new Error(`OIDC discovery unreachable at ${discoveryUrl}: ${(err as Error).message}`);
  }
  if (!res.ok)
    throw new Error(`OIDC discovery returned HTTP ${res.status} from ${discoveryUrl}`);

  const doc = await res.json() as Record<string, unknown>;
  if (typeof doc.introspection_endpoint !== 'string')
    throw new Error(`OIDC discovery at ${discoveryUrl} does not advertise an introspection_endpoint`);

  return doc.introspection_endpoint;
}

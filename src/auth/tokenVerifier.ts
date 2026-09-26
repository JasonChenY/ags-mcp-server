/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { createTokenIntrospector } from './tokenIntrospector.js';
import type { AuthConfig, AuthContext } from './types.js';

export type TokenVerifier = (bearer: string) => Promise<AuthContext>;

/**
 * Build a token verifier for the Resource Server.
 *
 * When `clientId` and `clientSecret` are configured the server acts as a
 * Confidential Client and delegates validation to Keycloak's introspection
 * endpoint (RFC 7662), discovered via OIDC Discovery (RFC 8414). This is the
 * preferred path: it works for opaque tokens, and Keycloak enforces revocation
 * in real time.
 *
 * When no client credentials are configured the server falls back to local
 * JWKS signature verification — suitable for development or environments where
 * network calls to the authorization server are not possible.
 */
export async function createTokenVerifier(config: AuthConfig): Promise<TokenVerifier> {
  if (config.clientId && config.clientSecret)
    return createTokenIntrospector(config);

  return createJwksVerifier(config);
}

function createJwksVerifier(config: AuthConfig): TokenVerifier {
  const jwksUri = config.jwksUri ?? `${config.issuer}/protocol/openid-connect/certs`;
  // Generous timeout: the JWKS endpoint may be slow on first fetch; keys are cached after.
  const jwks = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 15000 });
  const allowedAzp = config.allowedAzp?.length ? new Set(config.allowedAzp) : undefined;

  return async (bearer: string): Promise<AuthContext> => {
    const { payload } = await jwtVerify(bearer, jwks, {
      issuer: config.issuer,
      audience: config.audience ?? config.resource,
      algorithms: ['RS256'],
      clockTolerance: 30,
    });

    if (typeof payload.typ === 'string' && payload.typ !== 'Bearer')
      throw new Error(`unexpected token typ: ${payload.typ}`);
    if (allowedAzp && typeof payload.azp === 'string' && !allowedAzp.has(payload.azp))
      throw new Error(`azp not allowed: ${payload.azp}`);
    if (!payload.sub)
      throw new Error('token missing sub');

    const username = typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;
    return { userId: payload.sub, username };
  };
}

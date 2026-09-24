/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

/** Configuration for running the MCP server as an OAuth2 Resource Server. */
export type AuthConfig = {
  /** OIDC issuer, e.g. `https://keycloak.eit217.cn/realms/eit217`. */
  issuer: string;
  /** JWKS endpoint. Defaults to `${issuer}/protocol/openid-connect/certs`. */
  jwksUri?: string;
  /** Canonical resource identifier advertised in RFC 9728 metadata (a URL). */
  resource: string;
  /** Expected `aud` claim (Keycloak client-audience mapper value, e.g. `ags-mcp-api`). Defaults to `resource`. */
  audience?: string;
  /** Optional allowlist of `azp` (client id) values. */
  allowedAzp?: string[];
  /** Authorization servers advertised in protected-resource metadata. Defaults to `[issuer]`. */
  authorizationServers?: string[];
};

/** Identity extracted from a validated access token, bound to a session. */
export type AuthContext = {
  /** Stable user id (JWT `sub`); multi-tenant key. */
  userId: string;
  /** Display name (JWT `preferred_username`). */
  username?: string;
};

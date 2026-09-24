/**
 * Copyright (c) Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import type { AuthConfig } from './types.js';

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** RFC 9728 OAuth 2.0 Protected Resource Metadata document. */
export function protectedResourceMetadata(config: AuthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: config.authorizationServers ?? [config.issuer],
    bearer_methods_supported: ['header'],
  };
}

/** Build a `WWW-Authenticate: Bearer ...` challenge pointing at the protected-resource metadata. */
export function bearerChallenge(resourceMetadataUrl: string, error?: string, errorDescription?: string): string {
  const params: string[] = [];
  if (error)
    params.push(`error="${error}"`);
  if (errorDescription)
    params.push(`error_description="${errorDescription.replace(/"/g, '\'')}"`);
  params.push(`resource_metadata="${resourceMetadataUrl}"`);
  return `Bearer ${params.join(', ')}`;
}

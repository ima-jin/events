/**
 * Minimal contract fixture for the two kernel `pay` endpoints the events app
 * consumes: reading a DID's balance and transferring balance between DIDs.
 *
 * PROVENANCE: transcribed (reduced to the consumed endpoints/fields) from the
 * kernel's PUBLISHED pay API description, `apps/kernel/api-spec/pay.yaml`
 * (ima-jin/imajin-ai, openapi 3.1.0, info.version 2.0.0 — operations
 * `getBalance` and `transferBalance`, schema `Balance`; balance schema per
 * #2016, transfer auth per #2002). It is checked in so the contract tests run
 * standalone, with no sibling kernel checkout. When the public pay API
 * changes in a way events depends on, update this fixture deliberately.
 *
 * Shaped like an OpenAPI document (servers/paths/components) so the tests
 * read like the spec they pin; only the consumed subset is kept.
 */

export interface PayContractParameter {
  name: string;
  in: 'path';
  required: true;
}

export interface PayContractOperation {
  operationId: string;
  /** Alternative security requirements; any ONE satisfies the endpoint. */
  security: string[];
  parameters?: PayContractParameter[];
  requestBody?: {
    required: string[];
    properties: Record<string, { type: string; enum?: string[] }>;
  };
  /** HTTP statuses the spec documents for this operation. */
  responses: number[];
}

export interface PayContract {
  server: {
    /** `servers[].url` path suffix; `{service}` defaults to `pay`. */
    pathPrefix: string;
    serviceDefault: string;
  };
  securitySchemes: Record<string, { type: string; in?: string; name?: string; scheme?: string }>;
  paths: Record<string, Partial<Record<'get' | 'post', PayContractOperation>>>;
  schemas: {
    Balance: { properties: Record<string, { type: string }> };
  };
}

export const PAY_CONTRACT: PayContract = {
  server: { pathPrefix: '/{service}', serviceDefault: 'pay' },
  securitySchemes: {
    cookieAuth: { type: 'apiKey', in: 'cookie', name: 'imajin_session' },
    bearerAuth: { type: 'http', scheme: 'bearer' },
  },
  paths: {
    '/api/balance/{did}': {
      get: {
        operationId: 'getBalance',
        security: ['cookieAuth', 'bearerAuth'],
        parameters: [{ name: 'did', in: 'path', required: true }],
        responses: [200, 401, 403],
      },
    },
    '/api/balance/transfer': {
      post: {
        operationId: 'transferBalance',
        security: ['cookieAuth', 'bearerAuth'],
        requestBody: {
          required: ['from_did', 'to_did', 'amount'],
          properties: {
            from_did: { type: 'string' },
            to_did: { type: 'string' },
            amount: { type: 'number' },
            unit: { type: 'string', enum: ['MJN', 'MJNx'] },
            metadata: { type: 'object' },
          },
        },
        responses: [200, 400, 401, 402, 403],
      },
    },
  },
  schemas: {
    Balance: {
      properties: {
        did: { type: 'string' },
        balances: { type: 'array' },
        total: { type: 'number' },
        currency: { type: 'string' },
        updatedAt: { type: 'string' },
      },
    },
  },
};

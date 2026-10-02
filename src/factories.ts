import type { ZodType } from 'zod';

const json = <TSchema extends ZodType>(schema: TSchema, description: string) => ({
  description,
  content: {
    'application/json': { schema },
  },
});

/** A JSON response: `{ description, content: { 'application/json': { schema } } }`. */
export const jsonResponse = json;

/** A JSON request body. Same shape as {@link jsonResponse}; not marked `required`. */
export const jsonBody = json;

/**
 * A `request` fragment with a required JSON body: `{ body: { ...jsonBody(...), required: true } }`.
 * Spread or assign it as a route's `request`.
 */
export const jsonRequest = <TSchema extends ZodType>(schema: TSchema, description: string) => ({
  // `required: true` makes zod-openapi validate the body even when the request has no
  // JSON content-type; without it a body-less request reaches the handler as `{}`.
  body: { ...jsonBody(schema, description), required: true },
});

/** A response without a body (for example a 204): `{ description }`. */
export const emptyResponse = (description: string) => ({
  description,
});

/** @deprecated Use {@link jsonResponse}. Removed in 2.0. */
export const makeHonoResponse = jsonResponse;

/** @deprecated Use {@link jsonBody}. Removed in 2.0. */
export const makeHonoJsonBody = jsonBody;

/** @deprecated Use {@link jsonRequest}. Removed in 2.0. */
export const makeHonoJsonRequest = jsonRequest;

/** @deprecated Use {@link emptyResponse}. Removed in 2.0. */
export const makeHonoNoContentResponse = emptyResponse;

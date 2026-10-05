import type { ZodType } from 'zod';

const json = <TSchema extends ZodType>(schema: TSchema, description: string) => ({
  description,
  content: {
    'application/json': { schema },
  },
});

/** A JSON response: `{ description, content: { 'application/json': { schema } } }`. */
export const jsonResponse = json;

/** A JSON request body with the shape of {@link jsonResponse}. It is not `required`. */
export const jsonBody = json;

/** A route `request` with a required JSON body. */
export const jsonRequest = <TSchema extends ZodType>(schema: TSchema, description: string) => ({
  // Without `required: true`, zod-openapi skips the body check for a request without a JSON
  // content-type, and the handler gets `{}`.
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

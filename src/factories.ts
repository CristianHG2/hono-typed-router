import type { ZodType } from 'zod';

export const makeHonoResponse = <TSchema extends ZodType>(
  schema: TSchema,
  description: string,
) => ({
  description,
  content: {
    'application/json': { schema },
  },
});

export const makeHonoJsonBody = <TSchema extends ZodType>(
  schema: TSchema,
  description: string,
) => ({
  description,
  content: {
    'application/json': {
      schema,
    },
  },
});

export const makeHonoJsonRequest = <TSchema extends ZodType>(
  schema: TSchema,
  description: string,
) => ({
  // `required: true` makes zod-openapi validate the body even when the request has no
  // JSON content-type; without it a body-less request reaches the handler as `{}`.
  body: { ...makeHonoJsonBody(schema, description), required: true },
});

export const makeHonoNoContentResponse = (description: string) => ({
  description,
});

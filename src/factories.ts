import type { ZodType } from 'zod';

export const makeHonoResponse = <TSchema extends ZodType>(schema: TSchema, description: string) => ({
  description,
  content: {
    'application/json': { schema },
  },
});

export const makeHonoJsonBody = <TSchema extends ZodType>(schema: TSchema, description: string) => ({
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
  body: makeHonoJsonBody(schema, description),
});

export const makeHonoNoContentResponse = (description: string) => ({
  description,
});

import { expectTypeOf } from 'expect-type';
import { z, type ZodUnion } from 'zod';
import { defineRootRoute } from '../definitions';
import { makeHonoResponse } from '../factories';
import { createRouter } from './lib';

const okResponse = makeHonoResponse(z.object({ ok: z.boolean() }), 'OK');

// `route(method, config)` returns a value whose `method` and `path` are literal
{
  const ctx = defineRootRoute('/api', []);
  createRouter()(ctx, ({ route }) => {
    const declared = route('post', { responses: { 200: okResponse } });

    expectTypeOf(declared.method).toEqualTypeOf<'post'>();
    expectTypeOf(declared.path).toEqualTypeOf<'/api'>();
    expectTypeOf(declared.responses).toMatchTypeOf<{ 200: typeof okResponse }>();

    return undefined;
  });
}

// `makeRouter` result is a thunk producing the factory's return value
{
  const ctx = defineRootRoute('/api', []);
  const builder = createRouter()(ctx, ({ router }) => router);

  expectTypeOf(builder).toBeFunction();
  const built = builder();
  expectTypeOf(built).not.toBeAny();
}

// `base` merges into the static return type of `route()`
{
  const errResponse = makeHonoResponse(z.object({ error: z.string() }), 'Unauthorized');
  const ctx = defineRootRoute('/api', []);

  createRouter({ base: { responses: { 401: errResponse } } })(ctx, ({ route }) => {
    const declared = route('get', { responses: { 200: okResponse } });

    // Both the per-route 200 and the base 401 must be visible on the merged type.
    expectTypeOf(declared.responses).toMatchTypeOf<{
      200: typeof okResponse;
      401: typeof errResponse;
    }>();

    // path / method literals are preserved through the merge.
    expectTypeOf(declared.method).toEqualTypeOf<'get'>();
    expectTypeOf(declared.path).toEqualTypeOf<'/api'>();

    return undefined;
  });
}

// Colliding zod schemas at the same merge slot become a `ZodUnion<[A, B]>`
{
  const baseSchema = z.object({ code: z.literal('BASE') });
  const routeSchema = z.object({ code: z.literal('ROUTE') });
  const baseResp = makeHonoResponse(baseSchema, 'base');
  const routeResp = makeHonoResponse(routeSchema, 'route');

  const ctx = defineRootRoute('/api', []);

  createRouter({ base: { responses: { 422: baseResp } } })(ctx, ({ route }) => {
    const declared = route('get', { responses: { 200: okResponse, 422: routeResp } });

    type MergedSchema = (typeof declared)['responses'][422]['content']['application/json']['schema'];
    expectTypeOf<MergedSchema>().toEqualTypeOf<
      ZodUnion<readonly [typeof baseSchema, typeof routeSchema]>
    >();

    return undefined;
  });
}

// `transformRoute` does not influence the static return type of `route()`
{
  const ctx = defineRootRoute('/api', []);

  createRouter({
    transformRoute: (r) => ({ ...r, tags: ['x'] }),
  })(ctx, ({ route }) => {
    const declared = route('post', { responses: { 200: okResponse } });

    expectTypeOf(declared.method).toEqualTypeOf<'post'>();
    expectTypeOf(declared.responses).toMatchTypeOf<{ 200: typeof okResponse }>();
    // `tags` is not part of the declared input, so it should NOT appear on the type
    // (the transformer is a runtime-only escape hatch).
    expectTypeOf<keyof typeof declared>().not.toMatchTypeOf<'tags'>();

    return undefined;
  });
}

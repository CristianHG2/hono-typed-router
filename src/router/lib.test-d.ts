import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
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

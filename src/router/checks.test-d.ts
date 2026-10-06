import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonResponse } from '../factories';
import type { CheckChildren } from './children';
import { createRouter } from './lib';
import type { CheckPathParams } from './path-params';

// These tests assert the exact text of the compile-time errors of the router. `lib.test-d.ts`
// shows each error at a call site.

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

// A declared path param that the path does not have names the path and the param.
{
  const thingIdParams = z.object({ thingId: z.string() });

  expectTypeOf<
    CheckPathParams<
      '/api/orgs/:orgId/things/:id{[0-9]+}',
      { request: { params: typeof thingIdParams } }
    >['request']['params']
  >().toEqualTypeOf<"The path '/api/orgs/:orgId/things/:id{[0-9]+}' has no param named 'thingId'">();
}

// A children array variable with one typed element type tells you to pass the children inline
// or as const.
{
  const root = defineRootContext('/api', []);
  const things = defineChildContext(root, '/things');
  const makeRouter = createRouter();

  const statsRouter = makeRouter(things, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const byIdRouter = makeRouter(defineChildContext(things, '/:id'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('delete', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const plain = [statsRouter, byIdRouter];

  expectTypeOf<
    CheckChildren<typeof plain>
  >().toEqualTypeOf<'Pass children inline or as const: a children array variable has one element type, and the app type can lose the routes of some children'>();
}

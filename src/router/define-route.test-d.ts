import { expectTypeOf } from 'expect-type';
import { createMiddleware } from 'hono/factory';
import { z, type ZodUnion } from 'zod';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonResponse } from '../schema-helpers';
import { createRouter } from './create-router';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

// `defineRoute(method, config)` returns a value whose `method` and `path` are literal
{
  const ctx = defineRootContext('/api', []);
  createRouter()(ctx, ({ defineRoute }) => {
    const declared = defineRoute('post', { responses: { 200: okResponse } });

    expectTypeOf(declared.method).toEqualTypeOf<'post'>();
    expectTypeOf(declared.path).toEqualTypeOf<'/api'>();
    expectTypeOf(declared.responses).toMatchTypeOf<{ 200: typeof okResponse }>();

    return undefined;
  });
}

// `routeDefaults` merges into the static return type of `defineRoute()`
{
  const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { responses: { 401: errResponse } } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', { responses: { 200: okResponse } });

    expectTypeOf(declared.responses).toMatchTypeOf<{
      200: typeof okResponse;
      401: typeof errResponse;
    }>();

    expectTypeOf(declared.method).toEqualTypeOf<'get'>();
    expectTypeOf(declared.path).toEqualTypeOf<'/api'>();

    return undefined;
  });
}

// Two zod schemas at the same merge slot become a `ZodUnion<[A, B]>`
{
  const baseSchema = z.object({ code: z.literal('BASE') });
  const routeSchema = z.object({ code: z.literal('ROUTE') });
  const baseResp = jsonResponse(baseSchema, 'base');
  const routeResp = jsonResponse(routeSchema, 'route');

  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { responses: { 422: baseResp } } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', { responses: { 200: okResponse, 422: routeResp } });

    type MergedSchema =
      (typeof declared)['responses'][422]['content']['application/json']['schema'];

    expectTypeOf<MergedSchema>().toEqualTypeOf<
      ZodUnion<readonly [typeof baseSchema, typeof routeSchema]>
    >();

    return undefined;
  });
}

// `transformRoute` does not influence the static return type of `defineRoute()`
{
  const ctx = defineRootContext('/api', []);

  createRouter({
    transformRoute: (r) => ({ ...r, tags: ['x'] }),
  })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('post', { responses: { 200: okResponse } });

    expectTypeOf(declared.method).toEqualTypeOf<'post'>();
    expectTypeOf(declared.responses).toMatchTypeOf<{ 200: typeof okResponse }>();
    expectTypeOf<keyof typeof declared>().not.toMatchTypeOf<'tags'>();

    return undefined;
  });
}

// `routeDefaults` and a route with different status codes keep their exact response types
{
  const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { responses: { 401: errResponse } } })(
    ctx,
    ({ app, defineRoute }) => {
      const declared = defineRoute('get', { responses: { 200: okResponse } });

      expectTypeOf(declared.responses[200]).toEqualTypeOf<typeof okResponse>();
      expectTypeOf(declared.responses[401]).toEqualTypeOf<typeof errResponse>();
      expectTypeOf<keyof typeof declared.responses>().toEqualTypeOf<200 | 401>();

      app.openapi(declared, (c) => c.json({ ok: true }, 200));
      app.openapi(declared, (c) => c.json({ error: 'nope' }, 401));
    },
  );
}

// For the same status, a base schema and a route entry with only a description keep the base schema
{
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { responses: { 200: okResponse } } })(
    ctx,
    ({ app, defineRoute }) => {
      const declared = defineRoute('get', { responses: { 200: { description: 'Overridden' } } });

      type Merged = (typeof declared)['responses'][200];

      expectTypeOf<Merged['content']>().toEqualTypeOf<(typeof okResponse)['content']>();
      // `defineRoute` infers the config as `const`, so the description is a literal.
      expectTypeOf<Merged['description']>().toEqualTypeOf<'Overridden'>();

      app.openapi(declared, (c) => c.json({ ok: true }, 200));
      // @ts-expect-error the base schema applies to the merged 200
      app.openapi(declared, (c) => c.json({ ok: 'no' }, 200));
    },
  );
}

// `routeDefaults.request.params` and a route `request.query` keep both validation targets typed
{
  const ctx = defineRootContext('/things/:id', []);

  createRouter({ routeDefaults: { request: { params: z.object({ id: z.string() }) } } })(
    ctx,
    ({ app, defineRoute }) => {
      const declared = defineRoute('get', {
        request: { query: z.object({ q: z.string() }) },
        responses: { 200: okResponse },
      });

      app.openapi(declared, (c) => {
        expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ id: string }>();
        expectTypeOf(c.req.valid('query')).toEqualTypeOf<{ q: string }>();

        return c.json({ ok: true }, 200);
      });
    },
  );
}

// A merged array is an array of the element union, not a tuple, because the runtime removes duplicates
{
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { tags: ['api'] } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', {
      tags: ['api', 'things'],
      responses: { 200: okResponse },
    });

    expectTypeOf(declared.tags).toEqualTypeOf<('api' | 'things')[]>();
    // @ts-expect-error no tuple length
    const length: 3 = declared.tags.length;

    return length;
  });
}

// An explicit `undefined` on a route key widens the base type (the runtime copies it)
{
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { summary: 'From base' } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', { summary: undefined, responses: { 200: okResponse } });

    expectTypeOf(declared.summary).toEqualTypeOf<'From base' | undefined>();

    return undefined;
  });
}

// A route `security: []` opts out of `routeDefaults.security`. Another empty array keeps the defaults
{
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { security: [{ bearer: ['things:read'] }], tags: ['api'] } })(
    ctx,
    ({ app, defineRoute }) => {
      const open = defineRoute('get', { security: [], responses: { 200: okResponse } });
      const tagged = defineRoute('get', { tags: [], responses: { 200: okResponse } });

      expectTypeOf(open.security).toEqualTypeOf<[]>();
      expectTypeOf(tagged.tags).toEqualTypeOf<'api'[]>();

      app.openapi(open, (c) => c.json({ ok: true }, 200));
    },
  );
}

// The deprecated `base` option infers `const TBase` and merges as `routeDefaults` does
{
  const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { responses: { 401: errResponse }, tags: ['api'] } })(
    ctx,
    ({ defineRoute: withDefaults }) => {
      createRouter({ base: { responses: { 401: errResponse }, tags: ['api'] } })(
        ctx,
        ({ defineRoute: withBase }) => {
          const a = withDefaults('get', { tags: ['x'], responses: { 200: okResponse } });
          const b = withBase('get', { tags: ['x'], responses: { 200: okResponse } });

          expectTypeOf(b).toEqualTypeOf(a);
          expectTypeOf(b.tags).toEqualTypeOf<('api' | 'x')[]>();
          expectTypeOf(b.responses[401]).toEqualTypeOf<typeof errResponse>();

          return undefined;
        },
      );

      return undefined;
    },
  );
}

// `request.params` comes from the context path: no declaration needed
{
  const root = defineRootContext('/api', []);
  const orgThings = defineChildContext(root, '/orgs/:orgId/things');
  const thingById = defineChildContext(orgThings, '/:id{[0-9]+}');
  const makeRouter = createRouter();

  makeRouter(thingById, ({ app, defineRoute }) => {
    const get = defineRoute('get', { responses: { 200: okResponse } });

    const put = defineRoute('put', {
      request: { params: z.object({ id: z.coerce.number() }) },
      responses: { 200: okResponse },
    });

    return app
      .openapi(get, (c) => {
        expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ orgId: string; id: string }>();

        return c.json({ ok: true }, 200);
      })
      .openapi(put, (c) => {
        expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ id: number; orgId: string }>();

        return c.json({ ok: true }, 200);
      });
  });

  makeRouter(thingById, ({ defineRoute }) => {
    defineRoute('get', {
      // @ts-expect-error The path '/api/orgs/:orgId/things/:id{[0-9]+}' has no param named 'thingId'
      request: { params: z.object({ thingId: z.string() }) },
      responses: { 200: okResponse },
    });
  });

  makeRouter(thingById, ({ app, defineRoute }) =>
    app.openapi(
      defineRoute('get', {
        request: { query: z.object({ q: z.string() }) },
        responses: { 200: okResponse },
      }),
      (c) => {
        expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ orgId: string; id: string }>();
        expectTypeOf(c.req.valid('query')).toEqualTypeOf<{ q: string }>();

        return c.json({ ok: true }, 200);
      },
    ),
  );

  const notes = defineChildContext<typeof thingById>()('/notes/:noteId');

  makeRouter(notes, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) => {
      expectTypeOf(c.req.valid('param')).toEqualTypeOf<{
        orgId: string;
        id: string;
        noteId: string;
      }>();

      return c.json({ ok: true }, 200);
    }),
  );

  // OpenAPI cannot show an optional path param, so it is not added.
  makeRouter(defineChildContext(root, '/files/:name?'), ({ app, defineRoute }) => {
    const declared = defineRoute('get', { responses: { 200: okResponse } });

    expectTypeOf<'request' extends keyof typeof declared ? true : false>().toEqualTypeOf<false>();

    return app.openapi(declared, (c) => {
      expectTypeOf(c.req.param('name')).toEqualTypeOf<string | undefined>();

      return c.json({ ok: true }, 200);
    });
  });

  makeRouter(defineChildContext(root, '/files/:dir/:name?'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) => {
      expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ dir: string }>();

      return c.json({ ok: true }, 200);
    }),
  );

  createRouter({
    routeDefaults: { request: { params: z.object({ v: z.string().optional() }) } },
  })(thingById, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) => {
      expectTypeOf(c.req.valid('param')).toEqualTypeOf<{
        v?: string | undefined;
        orgId: string;
        id: string;
      }>();

      return c.json({ ok: true }, 200);
    }),
  );

  makeRouter(root, ({ defineRoute }) => {
    const declared = defineRoute('get', { responses: { 200: okResponse } });

    expectTypeOf<'request' extends keyof typeof declared ? true : false>().toEqualTypeOf<false>();
  });

  // A widened `string` path does not check the declared keys.
  const widened = defineRootContext('/api' as string, []);

  makeRouter(widened, ({ defineRoute }) =>
    defineRoute('get', {
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: okResponse },
    }),
  );
}

// `const` route config: a `middleware` array is a tuple, so the handler gets each var
{
  const ctx = defineRootContext('/api', []);

  const a = createMiddleware<{ Variables: { a: string } }>(async (_c, next) => {
    await next();
  });

  const b = createMiddleware<{ Variables: { b: number } }>(async (_c, next) => {
    await next();
  });

  createRouter()(ctx, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { middleware: [a, b], responses: { 200: okResponse } }), (c) => {
      expectTypeOf(c.var.a).toEqualTypeOf<string>();
      expectTypeOf(c.var.b).toEqualTypeOf<number>();

      return c.json({ ok: true }, 200);
    }),
  );

  createRouter({ routeDefaults: { middleware: [a] } })(ctx, ({ app, defineRoute }) => {
    const declared = defineRoute('get', { middleware: [b], responses: { 200: okResponse } });

    expectTypeOf(declared.middleware).toEqualTypeOf<[typeof a, typeof b]>();

    return app.openapi(declared, (c) => {
      expectTypeOf(c.var.a).toEqualTypeOf<string>();
      expectTypeOf(c.var.b).toEqualTypeOf<number>();

      return c.json({ ok: true }, 200);
    });
  });
}

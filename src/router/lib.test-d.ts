import type { OpenAPIHono } from '@hono/zod-openapi';
import { expectTypeOf } from 'expect-type';
import { testClient } from 'hono/testing';
import { z, type ZodUnion } from 'zod';
import { defineChildRoute, defineRootRoute } from '../definitions';
import { jsonRequest, jsonResponse } from '../factories';
import { createRouter } from './lib';
import type { RouteHookMeta } from './types';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

// `defineRoute(method, config)` returns a value whose `method` and `path` are literal
{
  const ctx = defineRootRoute('/api', []);
  createRouter()(ctx, ({ defineRoute }) => {
    const declared = defineRoute('post', { responses: { 200: okResponse } });

    expectTypeOf(declared.method).toEqualTypeOf<'post'>();
    expectTypeOf(declared.path).toEqualTypeOf<'/api'>();
    expectTypeOf(declared.responses).toMatchTypeOf<{ 200: typeof okResponse }>();

    return undefined;
  });
}

// The deprecated `route` key holds the same function type as `defineRoute`, and the 1.0
// destructuring `({ router, route })` still compiles and declares routes.
{
  const ctx = defineRootRoute('/api', []);
  createRouter({ routeDefaults: { tags: ['api'] } })(ctx, (options) => {
    expectTypeOf(options).toHaveProperty('defineRoute');
    expectTypeOf(options).toHaveProperty('route');
    expectTypeOf(options.route).toEqualTypeOf(options.defineRoute);

    return undefined;
  });

  const app = createRouter()(ctx, ({ router, route }) =>
    router.openapi(route('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  )();

  expectTypeOf(app).toExtend<OpenAPIHono<any, { '/api': any }, any>>();
}

// `makeRouter` result is a thunk producing the factory's return value
{
  const ctx = defineRootRoute('/api', []);
  const builder = createRouter()(ctx, ({ router }) => router);

  expectTypeOf(builder).toBeFunction();
  const built = builder();
  expectTypeOf(built).not.toBeAny();
}

// The parent's mount argument is internal: every thunk's public type takes no parameters,
// with or without children, and a thunk is still accepted as a child.
{
  const ctx = defineRootRoute('/api', []);
  const makeRouter = createRouter();
  const child = makeRouter(defineChildRoute<typeof ctx>()('/things'), ({ router }) => router);
  const parent = makeRouter(ctx, () => {}, [child]);

  expectTypeOf(child).parameters.toEqualTypeOf<[]>();
  expectTypeOf(parent).parameters.toEqualTypeOf<[]>();
  expectTypeOf(child).toMatchTypeOf<() => OpenAPIHono<any, any, any>>();
}

// A factory that returns nothing yields the router itself from the thunk
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: string }>(async (_c, next) => {
    await next();
  });

  const builder = createRouter()(ctx, () => {});

  expectTypeOf(builder()).toEqualTypeOf<OpenAPIHono<{ Variables: typeof ctx.vars }>>();
  expectTypeOf(builder()).not.toBeAny();
}

// A factory that returns the router (or anything else) keeps that return type
{
  const ctx = defineRootRoute('/api', []);
  const router = createRouter()(ctx, ({ router }) => router);
  const custom = createRouter()(ctx, () => ({ custom: true as const }));

  expectTypeOf(router()).toEqualTypeOf<OpenAPIHono<{ Variables: typeof ctx.vars }>>();
  expectTypeOf(custom()).toEqualTypeOf<{ custom: true }>();
}

// Children: the factory must return a router (or nothing); `children` stays optional
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: string }>(async (_c, next) => {
    await next();
  });

  type Router = OpenAPIHono<{ Variables: typeof ctx.vars }>;

  const makeRouter = createRouter();
  const child = makeRouter(defineChildRoute<typeof ctx>()('/things'), ({ router }) => router);
  const maybeChildren = [child] as (() => OpenAPIHono<any, any, any>)[] | undefined;

  expectTypeOf(makeRouter(ctx, ({ router }) => router, [child])()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, ({ router }) => router, [])()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, ({ router }) => router, undefined)()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, ({ router }) => router, maybeChildren)()).toEqualTypeOf<Router>();

  // A factory that returns nothing still accepts children (they mount on the router).
  expectTypeOf(makeRouter(ctx, () => {}, [child])()).toEqualTypeOf<Router>();

  // Conditional / null returns resolve to the router, matching `result ?? router`.
  const flag = Math.random() > 0.5;
  expectTypeOf(
    makeRouter(ctx, ({ router }) => {
      if (flag) return router;
    })(),
  ).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, () => null)()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, () => (flag ? { x: 1 } : undefined))()).toEqualTypeOf<
    { x: number } | Router
  >();

  // The destructured options stay typed under the children overload.
  makeRouter(
    ctx,
    ({ router, defineRoute }) => {
      expectTypeOf(router).toEqualTypeOf<Router>();
      expectTypeOf(
        defineRoute('get', { responses: { 200: okResponse } }).path,
      ).toEqualTypeOf<'/api'>();

      return router;
    },
    [child],
  );

  // @ts-expect-error — children are mounted on the factory's result, which must be a router
  makeRouter(ctx, () => ({ not: 'router' }), [child]);

  // Without children a non-router return is still allowed.
  expectTypeOf(makeRouter(ctx, () => ({ not: 'router' as const }))()).toEqualTypeOf<{
    not: 'router';
  }>();
}

// `routeDefaults` merges into the static return type of `defineRoute()`
{
  const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
  const ctx = defineRootRoute('/api', []);

  createRouter({ routeDefaults: { responses: { 401: errResponse } } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', { responses: { 200: okResponse } });

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
  const baseResp = jsonResponse(baseSchema, 'base');
  const routeResp = jsonResponse(routeSchema, 'route');

  const ctx = defineRootRoute('/api', []);

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
  const ctx = defineRootRoute('/api', []);

  createRouter({
    transformRoute: (r) => ({ ...r, tags: ['x'] }),
  })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('post', { responses: { 200: okResponse } });

    expectTypeOf(declared.method).toEqualTypeOf<'post'>();
    expectTypeOf(declared.responses).toMatchTypeOf<{ 200: typeof okResponse }>();
    // `tags` is not part of the declared input, so it should NOT appear on the type
    // (the transformer is a runtime-only escape hatch).
    expectTypeOf<keyof typeof declared>().not.toMatchTypeOf<'tags'>();

    return undefined;
  });
}

// `routeDefaults` + route with different status codes: both keep their exact response types
{
  const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
  const ctx = defineRootRoute('/api', []);

  createRouter({ routeDefaults: { responses: { 401: errResponse } } })(
    ctx,
    ({ router, defineRoute }) => {
      const declared = defineRoute('get', { responses: { 200: okResponse } });

      expectTypeOf(declared.responses[200]).toEqualTypeOf<typeof okResponse>();
      expectTypeOf(declared.responses[401]).toEqualTypeOf<typeof errResponse>();
      expectTypeOf<keyof typeof declared.responses>().toEqualTypeOf<200 | 401>();

      router.openapi(declared, (c) => c.json({ ok: true }, 200));
      router.openapi(declared, (c) => c.json({ error: 'nope' }, 401));

      return router;
    },
  );
}

// Same status: a base schema and a description-only route entry keep the base schema
{
  const ctx = defineRootRoute('/api', []);

  createRouter({ routeDefaults: { responses: { 200: okResponse } } })(
    ctx,
    ({ router, defineRoute }) => {
      const declared = defineRoute('get', { responses: { 200: { description: 'Overridden' } } });

      type Merged = (typeof declared)['responses'][200];

      expectTypeOf<Merged['content']>().toEqualTypeOf<(typeof okResponse)['content']>();
      expectTypeOf<Merged['description']>().toEqualTypeOf<string>();

      router.openapi(declared, (c) => c.json({ ok: true }, 200));
      // @ts-expect-error — the base schema still applies to the merged 200
      router.openapi(declared, (c) => c.json({ ok: 'no' }, 200));

      return router;
    },
  );
}

// `routeDefaults.request.params` + route `request.query`: both validation targets stay typed
{
  const ctx = defineRootRoute('/things/:id', []);

  createRouter({ routeDefaults: { request: { params: z.object({ id: z.string() }) } } })(
    ctx,
    ({ router, defineRoute }) => {
      const declared = defineRoute('get', {
        request: { query: z.object({ q: z.string() }) },
        responses: { 200: okResponse },
      });

      router.openapi(declared, (c) => {
        expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ id: string }>();
        expectTypeOf(c.req.valid('query')).toEqualTypeOf<{ q: string }>();

        return c.json({ ok: true }, 200);
      });

      return router;
    },
  );
}

// Merged arrays are element unions, not tuples (the runtime dedupes)
{
  const ctx = defineRootRoute('/api', []);

  createRouter({ routeDefaults: { tags: ['api'] } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', {
      tags: ['api', 'things'],
      responses: { 200: okResponse },
    });

    expectTypeOf(declared.tags).toEqualTypeOf<string[]>();
    // @ts-expect-error — no tuple length is promised
    const length: 3 = declared.tags.length;

    return length;
  });
}

// An explicit `undefined` on a route key widens the base type (the runtime copies it)
{
  const ctx = defineRootRoute('/api', []);

  createRouter({ routeDefaults: { summary: 'From base' } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', { summary: undefined, responses: { 200: okResponse } });

    expectTypeOf(declared.summary).toEqualTypeOf<'From base' | undefined>();

    return undefined;
  });
}

// A route `security: []` opts out of `routeDefaults.security`; other empty arrays stay additive
{
  const ctx = defineRootRoute('/api', []);

  createRouter({ routeDefaults: { security: [{ bearer: ['things:read'] }], tags: ['api'] } })(
    ctx,
    ({ router, defineRoute }) => {
      const open = defineRoute('get', { security: [], responses: { 200: okResponse } });
      const tagged = defineRoute('get', { tags: [], responses: { 200: okResponse } });

      expectTypeOf(open.security).toEqualTypeOf<[]>();
      expectTypeOf(tagged.tags).toEqualTypeOf<'api'[]>();

      router.openapi(open, (c) => c.json({ ok: true }, 200));

      return router;
    },
  );
}

// The deprecated `base` option infers `const TBase` and merges exactly like `routeDefaults`
{
  const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
  const ctx = defineRootRoute('/api', []);

  createRouter({ routeDefaults: { responses: { 401: errResponse }, tags: ['api'] } })(
    ctx,
    ({ defineRoute: withDefaults }) => {
      createRouter({ base: { responses: { 401: errResponse }, tags: ['api'] } })(
        ctx,
        ({ defineRoute: withBase }) => {
          const a = withDefaults('get', { tags: ['x'], responses: { 200: okResponse } });
          const b = withBase('get', { tags: ['x'], responses: { 200: okResponse } });

          expectTypeOf(b).toEqualTypeOf(a);
          expectTypeOf(b.tags).toEqualTypeOf<string[]>();
          expectTypeOf(b.responses[401]).toEqualTypeOf<typeof errResponse>();

          return undefined;
        },
      );

      return undefined;
    },
  );
}

// Hooks receive `RouteHookMeta` as a second argument; one-argument hooks still type-check
{
  createRouter({
    transformRoute: (config, meta) => {
      expectTypeOf(meta).toEqualTypeOf<RouteHookMeta>();
      expectTypeOf(meta.path).toEqualTypeOf<string>();

      return config;
    },
    routeMiddleware: [
      (_route, meta) => {
        expectTypeOf(meta).toEqualTypeOf<RouteHookMeta>();

        return async (_c, next) => {
          await next();
        };
      },
      () => async (_c, next) => {
        await next();
      },
    ],
  });
}

// Children carry their route schemas into the parent's type, so `testClient` sees them
{
  const thing = z.object({ id: z.string(), name: z.string() });
  const notFound = z.object({ message: z.string() });

  const root = defineRootRoute('/api', []);
  const thingsRoute = defineChildRoute(root, '/things');
  const thingRoute = defineChildRoute(thingsRoute, '/:id');
  const notesRoute = defineChildRoute(thingRoute, '/notes');

  const makeRouter = createRouter();

  const notes = makeRouter(notesRoute, ({ router, defineRoute }) =>
    router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const things = makeRouter(thingsRoute, ({ router, defineRoute }) =>
    router.openapi(
      defineRoute('post', {
        request: jsonRequest(z.object({ name: z.string() }), 'New thing'),
        responses: { 200: jsonResponse(thing, 'Created') },
      }),
      (c) => c.json({ id: '1', name: c.req.valid('json').name }, 200),
    ),
  );

  const thingById = makeRouter(
    thingRoute,
    ({ router, defineRoute }) =>
      router.openapi(
        defineRoute('get', {
          request: { params: z.object({ id: z.string() }) },
          responses: { 200: jsonResponse(thing, 'Found'), 404: jsonResponse(notFound, 'Missing') },
        }),
        (c) => c.json({ id: c.req.valid('param').id, name: 'x' }, 200),
      ),
    [notes],
  );

  // Parent + two children (one with its own child): every path is on the client.
  const app = makeRouter(root, ({ router }) => router, [things, thingById])();
  const client = testClient(app);

  const getThing = client.api.things[':id'].$get;

  type GetResponse = Awaited<ReturnType<typeof getThing>>;

  expectTypeOf<Parameters<typeof getThing>[0]>().toEqualTypeOf<{
    param: { id: string };
  }>();
  expectTypeOf<GetResponse['status']>().toEqualTypeOf<200 | 404>();
  expectTypeOf<Awaited<ReturnType<Extract<GetResponse, { status: 200 }>['json']>>>().toEqualTypeOf<{
    id: string;
    name: string;
  }>();
  expectTypeOf<Awaited<ReturnType<Extract<GetResponse, { status: 404 }>['json']>>>().toEqualTypeOf<{
    message: string;
  }>();

  expectTypeOf<Parameters<(typeof client)['api']['things']['$post']>[0]>().toEqualTypeOf<{
    json: { name: string };
  }>();
  // @ts-expect-error — `param.id` is required
  void client.api.things[':id'].$get({});
  // @ts-expect-error — `json.name` is required
  void client.api.things.$post({ json: {} });

  // Grandchild, mounted through its parent.
  const getNotes = client.api.things[':id'].notes.$get;
  expectTypeOf<Awaited<ReturnType<Awaited<ReturnType<typeof getNotes>>['json']>>>().toEqualTypeOf<{
    ok: boolean;
  }>();

  // A factory returning nothing still exposes the children's routes.
  const voidApp = makeRouter(root, () => {}, [things])();
  expectTypeOf<
    Parameters<ReturnType<typeof testClient<typeof voidApp>>['api']['things']['$post']>[0]
  >().toEqualTypeOf<{ json: { name: string } }>();

  // The parent's own routes and the children's routes are merged.
  const withOwn = makeRouter(
    root,
    ({ router, defineRoute }) =>
      router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    [things],
  )();

  type WithOwnClient = ReturnType<typeof testClient<typeof withOwn>>;

  expectTypeOf<WithOwnClient['api']['$get']>().toBeFunction();
  expectTypeOf<WithOwnClient['api']['things']['$post']>().toBeFunction();

  // A curried child (`defineChildRoute<typeof parent>()`) is typed at its full path too.
  const curried = makeRouter(
    defineChildRoute<typeof root>()('/curried/:slug'),
    ({ router, defineRoute }) =>
      router.openapi(
        defineRoute('get', {
          request: { params: z.object({ slug: z.string() }) },
          responses: { 200: okResponse },
        }),
        (c) => c.json({ ok: true }, 200),
      ),
  );

  const curriedApp = makeRouter(root, ({ router }) => router, [curried])();
  const getCurried = testClient(curriedApp).api.curried[':slug'].$get;

  expectTypeOf<Parameters<typeof getCurried>[0]>().toEqualTypeOf<{ param: { slug: string } }>();

  // A non-const children variable still compiles; a widened array adds no schema.
  const kids: (() => OpenAPIHono<any, any, any>)[] = [things, thingById];
  const loose = makeRouter(root, ({ router }) => router, kids)();
  expectTypeOf(loose).toEqualTypeOf<OpenAPIHono<{ Variables: {} }>>();
}

// A value-form child of a root `'/'` is keyed at `/things`, not `//things`.
{
  const root = defineRootRoute('/', []);
  const makeRouter = createRouter();

  const things = makeRouter(defineChildRoute(root, '/things'), ({ router, defineRoute }) =>
    router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, ({ router }) => router, [things])();

  type AppClient = ReturnType<typeof testClient<typeof app>>;

  expectTypeOf<AppClient['things']['$get']>().toBeFunction();
  expectTypeOf<keyof AppClient>().toEqualTypeOf<'things'>();
}

// A child segment without a leading `/` is keyed at `/api/x`, where Hono mounts it.
{
  const root = defineRootRoute('/api', []);
  const makeRouter = createRouter();

  const x = makeRouter(defineChildRoute(root, 'x'), ({ router, defineRoute }) =>
    router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, ({ router }) => router, [x])();

  type AppClient = ReturnType<typeof testClient<typeof app>>;

  expectTypeOf<keyof AppClient>().toEqualTypeOf<'api'>();
  expectTypeOf<keyof AppClient['api']>().toEqualTypeOf<'x'>();
  expectTypeOf<AppClient['api']['x']['$get']>().toBeFunction();
}

import type { OpenAPIHono } from '@hono/zod-openapi';
import { expectTypeOf } from 'expect-type';
import { createMiddleware } from 'hono/factory';
import { testClient } from 'hono/testing';
import { z, type ZodUnion } from 'zod';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonRequest, jsonResponse } from '../factories';
import { createRouter } from './lib';
import { mountRouter } from './mount';
import type { CheckCallbackResult, ChildRouter, RouteMeta, RouteMiddlewareFactory } from './types';

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

// The deprecated `route` key holds the same function type as `defineRoute`, and the 1.0
// destructuring `({ router, route })` still compiles and declares routes.
{
  const ctx = defineRootContext('/api', []);
  createRouter({ routeDefaults: { tags: ['api'] } })(ctx, (options) => {
    expectTypeOf(options).toHaveProperty('defineRoute');
    expectTypeOf(options).toHaveProperty('route');
    expectTypeOf(options.route).toEqualTypeOf(options.defineRoute);

    return undefined;
  });

  // The deprecated `router` key, on purpose: it holds the same app as `app`.
  const app = createRouter()(ctx, ({ router, route }) =>
    router.openapi(route('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  )();

  expectTypeOf(app).toExtend<OpenAPIHono<any, { '/api': any }, any>>();
}

// `makeRouter` result is a thunk producing the callback's return value
{
  const ctx = defineRootContext('/api', []);
  const builder = createRouter()(ctx, () => ({ value: 1 }));

  expectTypeOf(builder).toBeFunction();
  const built = builder();
  expectTypeOf(built).not.toBeAny();
}

// The parent's mount argument is internal: every thunk's public type takes no parameters,
// with or without children, and a thunk is still accepted as a child.
{
  const ctx = defineRootContext('/api', []);
  const makeRouter = createRouter();
  const child = makeRouter(defineChildContext<typeof ctx>()('/things'), () => {});
  const parent = makeRouter(ctx, () => {}, [child]);

  expectTypeOf(child).parameters.toEqualTypeOf<[]>();
  expectTypeOf(parent).parameters.toEqualTypeOf<[]>();
  expectTypeOf(child).toMatchTypeOf<() => OpenAPIHono<any, any, any>>();
}

// A factory that returns nothing yields the router itself from the thunk
{
  const ctx = defineRootContext('/api', []).middleware<{ user: string }>(async (_c, next) => {
    await next();
  });

  const builder = createRouter()(ctx, () => {});

  expectTypeOf(builder()).toEqualTypeOf<OpenAPIHono<{ Variables: typeof ctx.vars }>>();
  expectTypeOf(builder()).not.toBeAny();
}

// A callback that returns the `.openapi()` chain (or anything else) keeps that return type
{
  const ctx = defineRootContext('/api', []);

  const chain = createRouter()(ctx, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const custom = createRouter()(ctx, () => ({ custom: true as const }));

  expectTypeOf(chain()).toExtend<OpenAPIHono<any, { '/api': any }, any>>();
  expectTypeOf(custom()).toEqualTypeOf<{ custom: true }>();
}

// Without children, a callback that returns an app with no typed routes is an error. The
// usual cause: the routes are registered in separate statements, and the callback returns
// `app`. Returning nothing is the opt-out; with children, `({ app }) => app` stays legal.
{
  const ctx = defineRootContext('/api', []);
  const makeRouter = createRouter();

  expectTypeOf<
    CheckCallbackResult<OpenAPIHono<{ Variables: {} }>>
  >().toEqualTypeOf<'The callback returns an app with no typed routes. Return the .openapi() chain, or return nothing.'>();
  expectTypeOf<CheckCallbackResult<OpenAPIHono<any, any, any>>>().toEqualTypeOf<unknown>();
  expectTypeOf<CheckCallbackResult<{ custom: true }>>().toEqualTypeOf<unknown>();

  // @ts-expect-error — the callback returns an app with no typed routes
  makeRouter(ctx, ({ app, defineRoute }) => {
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    );

    return app;
  });

  // @ts-expect-error — also for `app` returned directly
  makeRouter(ctx, ({ app }) => app);

  const nothing = makeRouter(ctx, ({ app, defineRoute }) => {
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    );
  });

  const child = makeRouter(defineChildContext(ctx, '/things'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const parent = makeRouter(ctx, ({ app }) => app, [child]);

  expectTypeOf(nothing()).toEqualTypeOf<OpenAPIHono<{ Variables: {} }>>();
  expectTypeOf(parent()).toExtend<OpenAPIHono<any, { '/api/things': any }, any>>();
}

// Children: the factory must return a router (or nothing); `children` stays optional
{
  const ctx = defineRootContext('/api', []).middleware<{ user: string }>(async (_c, next) => {
    await next();
  });

  type Router = OpenAPIHono<{ Variables: typeof ctx.vars }>;

  const makeRouter = createRouter();
  const child = makeRouter(defineChildContext<typeof ctx>()('/things'), () => {});
  const maybeChildren = [child] as (() => OpenAPIHono<any, any, any>)[] | undefined;

  expectTypeOf(makeRouter(ctx, ({ app }) => app, [child])()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, ({ app }) => app, [])()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, ({ app }) => app, undefined)()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, ({ app }) => app, maybeChildren)()).toEqualTypeOf<Router>();

  // A factory that returns nothing still accepts children (they mount on the router).
  expectTypeOf(makeRouter(ctx, () => {}, [child])()).toEqualTypeOf<Router>();

  // Conditional / null returns resolve to the router, matching `result ?? router`.
  const flag = Math.random() > 0.5;
  expectTypeOf(
    makeRouter(ctx, ({ app }) => {
      if (flag) return app;
    })(),
  ).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, () => null)()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, () => (flag ? { x: 1 } : undefined))()).toEqualTypeOf<
    { x: number } | Router
  >();

  // The destructured options stay typed under the children overload.
  makeRouter(
    ctx,
    ({ app, defineRoute }) => {
      expectTypeOf(app).toEqualTypeOf<Router>();
      expectTypeOf(
        defineRoute('get', { responses: { 200: okResponse } }).path,
      ).toEqualTypeOf<'/api'>();

      return app;
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
  const ctx = defineRootContext('/api', []);

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
    // `tags` is not part of the declared input, so it should NOT appear on the type
    // (the transformer is a runtime-only escape hatch).
    expectTypeOf<keyof typeof declared>().not.toMatchTypeOf<'tags'>();

    return undefined;
  });
}

// `routeDefaults` + route with different status codes: both keep their exact response types
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

// Same status: a base schema and a description-only route entry keep the base schema
{
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { responses: { 200: okResponse } } })(
    ctx,
    ({ app, defineRoute }) => {
      const declared = defineRoute('get', { responses: { 200: { description: 'Overridden' } } });

      type Merged = (typeof declared)['responses'][200];

      expectTypeOf<Merged['content']>().toEqualTypeOf<(typeof okResponse)['content']>();
      // `defineRoute` infers the config as `const`, so the route's description is a literal.
      expectTypeOf<Merged['description']>().toEqualTypeOf<'Overridden'>();

      app.openapi(declared, (c) => c.json({ ok: true }, 200));
      // @ts-expect-error — the base schema still applies to the merged 200
      app.openapi(declared, (c) => c.json({ ok: 'no' }, 200));
    },
  );
}

// `routeDefaults.request.params` + route `request.query`: both validation targets stay typed
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

// Merged arrays are arrays of the element union, not tuples (the runtime dedupes)
{
  const ctx = defineRootContext('/api', []);

  createRouter({ routeDefaults: { tags: ['api'] } })(ctx, ({ defineRoute }) => {
    const declared = defineRoute('get', {
      tags: ['api', 'things'],
      responses: { 200: okResponse },
    });

    expectTypeOf(declared.tags).toEqualTypeOf<('api' | 'things')[]>();
    // @ts-expect-error — no tuple length is promised
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

// A route `security: []` opts out of `routeDefaults.security`; other empty arrays stay additive
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

// The deprecated `base` option infers `const TBase` and merges exactly like `routeDefaults`
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

// Hooks receive `RouteMeta` as a second argument; one-argument hooks still type-check
{
  createRouter({
    transformRoute: (config, meta) => {
      expectTypeOf(meta).toEqualTypeOf<RouteMeta>();
      expectTypeOf(meta.path).toEqualTypeOf<string>();

      return config;
    },
    routeMiddleware: [
      (_route, meta) => {
        expectTypeOf(meta).toEqualTypeOf<RouteMeta>();

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

  const root = defineRootContext('/api', []);
  const thingsRoute = defineChildContext(root, '/things');
  const thingRoute = defineChildContext(thingsRoute, '/:id');
  const notesRoute = defineChildContext(thingRoute, '/notes');

  const makeRouter = createRouter();

  const notes = makeRouter(notesRoute, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const things = makeRouter(thingsRoute, ({ app, defineRoute }) =>
    app.openapi(
      defineRoute('post', {
        request: jsonRequest(z.object({ name: z.string() }), 'New thing'),
        responses: { 200: jsonResponse(thing, 'Created') },
      }),
      (c) => c.json({ id: '1', name: c.req.valid('json').name }, 200),
    ),
  );

  const thingById = makeRouter(
    thingRoute,
    ({ app, defineRoute }) =>
      app.openapi(
        defineRoute('get', {
          request: { params: z.object({ id: z.string() }) },
          responses: { 200: jsonResponse(thing, 'Found'), 404: jsonResponse(notFound, 'Missing') },
        }),
        (c) => c.json({ id: c.req.valid('param').id, name: 'x' }, 200),
      ),
    [notes],
  );

  // Parent + two children (one with its own child): every path is on the client.
  const app = makeRouter(root, ({ app }) => app, [things, thingById])();
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
    ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    [things],
  )();

  type WithOwnClient = ReturnType<typeof testClient<typeof withOwn>>;

  expectTypeOf<WithOwnClient['api']['$get']>().toBeFunction();
  expectTypeOf<WithOwnClient['api']['things']['$post']>().toBeFunction();

  // A curried child (`defineChildContext<typeof parent>()`) is typed at its full path too.
  const curried = makeRouter(
    defineChildContext<typeof root>()('/curried/:slug'),
    ({ app, defineRoute }) =>
      app.openapi(
        defineRoute('get', {
          request: { params: z.object({ slug: z.string() }) },
          responses: { 200: okResponse },
        }),
        (c) => c.json({ ok: true }, 200),
      ),
  );

  const curriedApp = makeRouter(root, ({ app }) => app, [curried])();
  const getCurried = testClient(curriedApp).api.curried[':slug'].$get;

  expectTypeOf<Parameters<typeof getCurried>[0]>().toEqualTypeOf<{ param: { slug: string } }>();

  // A non-const children variable still compiles; a widened array adds no schema.
  const kids: (() => OpenAPIHono<any, any, any>)[] = [things, thingById];
  const loose = makeRouter(root, ({ app }) => app, kids)();
  expectTypeOf(loose).toEqualTypeOf<OpenAPIHono<{ Variables: {} }>>();
}

// A value-form child of a root `'/'` is keyed at `/things`, not `//things`.
{
  const root = defineRootContext('/', []);
  const makeRouter = createRouter();

  const things = makeRouter(defineChildContext(root, '/things'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, ({ app }) => app, [things])();

  type AppClient = ReturnType<typeof testClient<typeof app>>;

  expectTypeOf<AppClient['things']['$get']>().toBeFunction();
  expectTypeOf<keyof AppClient>().toEqualTypeOf<'things'>();
}

// A child segment without a leading `/` is keyed at `/api/x`, where Hono mounts it.
{
  const root = defineRootContext('/api', []);
  const makeRouter = createRouter();

  const x = makeRouter(defineChildContext(root, 'x'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, ({ app }) => app, [x])();

  type AppClient = ReturnType<typeof testClient<typeof app>>;

  expectTypeOf<keyof AppClient>().toEqualTypeOf<'api'>();
  expectTypeOf<keyof AppClient['api']>().toEqualTypeOf<'x'>();
  expectTypeOf<AppClient['api']['x']['$get']>().toBeFunction();
}

// A `makeRouter(...)` call nested inline in `children` type-checks, and the grandchild's
// route is in the schema of the outer router.
{
  const root = defineRootContext('/api', []);
  const things = defineChildContext(root, '/things');
  const thingById = defineChildContext(things, '/:id');
  const makeRouter = createRouter();

  const thingByIdRouter = makeRouter(thingById, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  type SchemaKeys<T> = T extends () => OpenAPIHono<any, infer S, any> ? keyof S : never;

  const voidNested = makeRouter(root, () => {}, [makeRouter(things, () => {}, [thingByIdRouter])]);

  expectTypeOf<SchemaKeys<typeof voidNested>>().toEqualTypeOf<'/api/things/:id'>();

  const routerNested = makeRouter(root, ({ app }) => app, [
    makeRouter(things, ({ app }) => app, [thingByIdRouter]),
  ]);

  expectTypeOf<SchemaKeys<typeof routerNested>>().toEqualTypeOf<'/api/things/:id'>();

  // The inner router's own routes are kept too.
  const withOwn = makeRouter(root, ({ app }) => app, [
    makeRouter(
      things,
      ({ app, defineRoute }) =>
        app.openapi(defineRoute('post', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        ),
      [thingByIdRouter],
    ),
  ]);

  expectTypeOf<SchemaKeys<typeof withOwn>>().toEqualTypeOf<'/api/things' | '/api/things/:id'>();
  expectTypeOf(testClient(withOwn()).api.things[':id'].$get).toBeFunction();
}

// A child at the segment `'/'` serves at the parent path: the schema key and the client
// use `'/api'`, not `'/api/'`.
{
  const root = defineRootContext('/api', []);
  const makeRouter = createRouter();

  const child = makeRouter(defineChildContext(root, '/'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, () => {}, [child]);

  type SchemaKeys<T> = T extends () => OpenAPIHono<any, infer S, any> ? keyof S : never;

  expectTypeOf<SchemaKeys<typeof app>>().toEqualTypeOf<'/api'>();
  expectTypeOf(testClient(app()).api.$get).toBeFunction();
}

// The children signature gives the same types as before for every form of `children`.
{
  const root = defineRootContext('/api', []);
  const makeRouter = createRouter();

  const child = makeRouter(defineChildContext(root, '/x'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  type Plain = () => OpenAPIHono<{ Variables: {} }>;

  type SchemaKeys<T> = T extends () => OpenAPIHono<any, infer S, any> ? keyof S : never;

  const viaRouter = ({ app }: { app: OpenAPIHono<{ Variables: {} }> }) => app;

  expectTypeOf(makeRouter(root, () => {})).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, () => {}, [])).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, () => {}, undefined)).toEqualTypeOf<Plain>();
  // @ts-expect-error — without children, a callback that returns an app with no routes is an error
  makeRouter(root, viaRouter);
  expectTypeOf(makeRouter(root, viaRouter, [])).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, viaRouter, undefined)).toEqualTypeOf<Plain>();

  const tuple = makeRouter(root, () => {}, [child]);
  expectTypeOf<SchemaKeys<typeof tuple>>().toEqualTypeOf<'/api/x'>();
  expectTypeOf(tuple).toEqualTypeOf(makeRouter(root, viaRouter, [child]));

  // With explicit type arguments and children, pass the children tuple type as the fourth
  // type argument. Three explicit type arguments plus `[]` give TS2554.
  expectTypeOf(makeRouter<'/api', {}, void, []>(root, () => {}, [])).toEqualTypeOf<Plain>();
  // @ts-expect-error TS2554: three explicit type arguments select the overload without children
  makeRouter<'/api', {}, void>(root, () => {}, []);

  // A widened array adds no schema.
  const kids: (() => OpenAPIHono<any, any, any>)[] = [child];
  expectTypeOf(makeRouter(root, () => {}, kids)).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, viaRouter, kids)).toEqualTypeOf<Plain>();
}

// `mountRouter(context, children)` returns the built app. Its type is the type of the long
// form `makeRouter(context, ({ router }) => router, children)()`.
{
  const thing = z.object({ id: z.string(), name: z.string() });

  const root = defineRootContext('/api', []).middleware<{ userId: string }>(async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });

  const things = defineChildContext(root, '/things');
  const thingById = defineChildContext(things, '/:id');
  const makeRouter = createRouter();

  const thingsRouter = makeRouter(things, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const byIdRouter = makeRouter(thingById, ({ app, defineRoute }) =>
    app.openapi(
      defineRoute('get', {
        request: { params: z.object({ id: z.string() }) },
        responses: { 200: jsonResponse(thing, 'Found') },
      }),
      (c) => c.json({ id: c.req.valid('param').id, name: c.var.userId }, 200),
    ),
  );

  const app = mountRouter(root, [thingsRouter, byIdRouter]);

  expectTypeOf(app).toEqualTypeOf(makeRouter(root, ({ app }) => app, [thingsRouter, byIdRouter])());

  // The app is built: it is not a thunk.
  expectTypeOf(app).toExtend<OpenAPIHono<any, any, any>>();
  // @ts-expect-error — the app is not a `ChildRouter`
  makeRouter(root, () => {}, [app]);

  // The vars of the context are in the app's Env.
  type AppEnv = typeof app extends OpenAPIHono<infer E, any, any> ? E : never;

  expectTypeOf<AppEnv>().toEqualTypeOf<{ Variables: { userId: string } }>();

  // The children's routes are in the app's Schema, so `testClient` sees them.
  type SchemaKeys<T> = T extends OpenAPIHono<any, infer S, any> ? keyof S : never;

  expectTypeOf<SchemaKeys<typeof app>>().toEqualTypeOf<'/api/things' | '/api/things/:id'>();

  const getThing = testClient(app).api.things[':id'].$get;

  type GetResponse = Awaited<ReturnType<typeof getThing>>;

  expectTypeOf<Parameters<typeof getThing>[0]>().toEqualTypeOf<{ param: { id: string } }>();
  expectTypeOf<Awaited<ReturnType<GetResponse['json']>>>().toEqualTypeOf<{
    id: string;
    name: string;
  }>();

  // An inline nested `makeRouter(...)` call compiles, and the grandchild's route is in the
  // schema of the app.
  const nested = mountRouter(root, [makeRouter(things, ({ app }) => app, [byIdRouter])]);

  expectTypeOf<SchemaKeys<typeof nested>>().toEqualTypeOf<'/api/things/:id'>();
  expectTypeOf(nested).toEqualTypeOf(
    makeRouter(root, ({ app }) => app, [makeRouter(things, ({ app }) => app, [byIdRouter])])(),
  );
  expectTypeOf(testClient(nested).api.things[':id'].$get).toBeFunction();

  // No children, or a widened array: the app is the plain router type.
  type Plain = OpenAPIHono<{ Variables: { userId: string } }>;

  expectTypeOf(mountRouter(root, [])).toEqualTypeOf<Plain>();

  const kids: (() => OpenAPIHono<any, any, any>)[] = [thingsRouter];
  expectTypeOf(mountRouter(root, kids)).toEqualTypeOf<Plain>();

  // `children` is required.
  // @ts-expect-error TS2554: expected 2 arguments
  mountRouter(root);
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
        // A declared key keeps its declared type; the missing path keys are strings.
        expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ id: number; orgId: string }>();

        return c.json({ ok: true }, 200);
      });
  });

  // A declared key that the path does not have is an error.
  makeRouter(thingById, ({ defineRoute }) => {
    defineRoute('get', {
      // @ts-expect-error The path '/api/orgs/:orgId/things/:id{[0-9]+}' has no param named 'thingId'
      request: { params: z.object({ thingId: z.string() }) },
      responses: { 200: okResponse },
    });
  });

  // The other request keys stay as declared.
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

  // A curried grandchild gets the keys of every parent.
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

  // An optional param is not added: OpenAPI cannot show it. `c.req.param` reads it.
  makeRouter(defineChildContext(root, '/files/:name?'), ({ app, defineRoute }) => {
    const declared = defineRoute('get', { responses: { 200: okResponse } });

    expectTypeOf<'request' extends keyof typeof declared ? true : false>().toEqualTypeOf<false>();

    return app.openapi(declared, (c) => {
      expectTypeOf(c.req.param('name')).toEqualTypeOf<string | undefined>();

      return c.json({ ok: true }, 200);
    });
  });

  // With a required param, only the required param is added.
  makeRouter(defineChildContext(root, '/files/:dir/:name?'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) => {
      expectTypeOf(c.req.valid('param')).toEqualTypeOf<{ dir: string }>();

      return c.json({ ok: true }, 200);
    }),
  );

  // `routeDefaults.request.params` gets the missing path params when the route has none.
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

  // A path without params adds no `param` target.
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

  // A `routeDefaults.middleware` tuple and a route tuple merge into one tuple.
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

// A route middleware factory may return `undefined`
{
  const factory: RouteMiddlewareFactory = (route) => (route.security ? undefined : undefined);

  createRouter({ routeMiddleware: [factory, () => undefined] });
}

// The callback gets the app as `app`, and as the deprecated `router`
{
  createRouter()(defineRootContext('/api', []), ({ app, router }) => {
    expectTypeOf(app).toEqualTypeOf(router);
    expectTypeOf(app).toEqualTypeOf<OpenAPIHono<{ Variables: {} }>>();
  });
}

// A children array variable with one typed element type is an error
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

  // The two children collapse to one element type: the routes of one child are lost.
  const plain = [statsRouter, byIdRouter];

  // @ts-expect-error Pass children inline or as const
  mountRouter(root, plain);
  // @ts-expect-error Pass children inline or as const
  makeRouter(root, () => {}, plain);

  // Inline, `as const`, and `ChildRouter[]` (the opt-out) pass.
  mountRouter(root, [statsRouter, byIdRouter]);
  const tuple = [statsRouter, byIdRouter] as const;

  mountRouter(root, tuple);

  const optOut: ChildRouter[] = [statsRouter, byIdRouter];

  expectTypeOf(mountRouter(root, optOut)).toEqualTypeOf<OpenAPIHono<{ Variables: {} }>>();

  // An element type that is a union keeps every child, so it passes.
  const union: (typeof statsRouter | typeof byIdRouter)[] = [statsRouter, byIdRouter];
  const app = mountRouter(root, union);

  expectTypeOf(testClient(app).api.things.$get).toBeFunction();
  expectTypeOf(testClient(app).api.things[':id'].$delete).toBeFunction();
}

// Bindings: a context without bindings gives the same app type as before bindings existed. A
// context with bindings gives `c.env` its bindings in each route handler.
{
  interface Db {
    query: (sql: string) => string;
  }

  interface Bindings {
    DB: Db;
  }

  interface SessionVars {
    userId: string;
  }

  const session = createMiddleware<{ Variables: SessionVars }>(async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });

  const auth = createMiddleware<{ Bindings: Bindings; Variables: SessionVars }>(async (c, next) => {
    c.set('userId', c.env.DB.query('select 1'));
    await next();
  });

  const makeRouter = createRouter();
  const plain = defineRootContext('/api', [session]);

  makeRouter(plain, ({ app, router }) => {
    expectTypeOf(app).toEqualTypeOf<OpenAPIHono<{ Variables: SessionVars }>>();
    expectTypeOf(router).toEqualTypeOf<OpenAPIHono<{ Variables: SessionVars }>>();
  });

  expectTypeOf(makeRouter(plain, () => {})()).toEqualTypeOf<
    OpenAPIHono<{ Variables: SessionVars }>
  >();
  expectTypeOf(makeRouter(plain, () => {}, [])()).toEqualTypeOf<
    OpenAPIHono<{ Variables: SessionVars }>
  >();
  expectTypeOf(mountRouter(plain, [])).toEqualTypeOf<OpenAPIHono<{ Variables: SessionVars }>>();

  const api = defineRootContext('/api', [auth]);

  makeRouter(api, ({ app }) => {
    expectTypeOf(app).toEqualTypeOf<OpenAPIHono<{ Bindings: Bindings; Variables: SessionVars }>>();
  });

  const things = makeRouter(defineChildContext(api, '/things'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) => {
      expectTypeOf(c.env.DB).toEqualTypeOf<Db>();

      return c.json({ ok: c.env.DB.query(c.var.userId) === '' }, 200);
    }),
  );

  const curried = makeRouter(defineChildContext<typeof api>()('/items'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: c.env.DB.query('select 1') === '' }, 200),
    ),
  );

  const app = mountRouter(api, [things, curried]);
  expectTypeOf(app).toExtend<OpenAPIHono<{ Bindings: Bindings; Variables: SessionVars }, any>>();

  const node = makeRouter(api, () => {}, [things]);
  expectTypeOf(node()).toExtend<OpenAPIHono<{ Bindings: Bindings; Variables: SessionVars }, any>>();

  // An explicit third type argument gives the same app.
  const explicit = defineRootContext<'/api', {}, Bindings>('/api').middleware(session);
  makeRouter(explicit, ({ app }) => {
    expectTypeOf(app).toEqualTypeOf<
      OpenAPIHono<{ Bindings: Bindings; Variables: {} & SessionVars }>
    >();
  });
}

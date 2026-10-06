import type { OpenAPIHono } from '@hono/zod-openapi';
import { expectTypeOf } from 'expect-type';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonResponse } from '../schema-helpers';
import { createRouter } from './create-router';
import { mountRouter } from './mount';
import type { CheckCallbackResult, RouteMeta, RouteMiddlewareFactory } from './types';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

// The deprecated `route` and `router` keys compile and declare routes
{
  const ctx = defineRootContext('/api', []);
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

// `makeRouter` returns a thunk that gives the return value of the callback
{
  const ctx = defineRootContext('/api', []);
  const builder = createRouter()(ctx, () => ({ value: 1 }));

  expectTypeOf(builder).toBeFunction();
  const built = builder();
  expectTypeOf(built).not.toBeAny();
}

// The public type of each thunk takes no parameters, and a thunk is a child
{
  const ctx = defineRootContext('/api', []);
  const makeRouter = createRouter();
  const child = makeRouter(defineChildContext<typeof ctx>()('/things'), () => {});
  const parent = makeRouter(ctx, () => {}, [child]);

  expectTypeOf(child).parameters.toEqualTypeOf<[]>();
  expectTypeOf(parent).parameters.toEqualTypeOf<[]>();
  expectTypeOf(child).toMatchTypeOf<() => OpenAPIHono<any, any, any>>();
}

// When the callback returns nothing, the thunk gives the router
{
  const ctx = defineRootContext('/api', []).middleware<{ user: string }>(async (_c, next) => {
    await next();
  });

  const builder = createRouter()(ctx, () => {});

  expectTypeOf(builder()).toEqualTypeOf<OpenAPIHono<{ Variables: typeof ctx.vars }>>();
  expectTypeOf(builder()).not.toBeAny();
}

// A callback that returns the `.openapi()` chain, or any other value, keeps that return type
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

// Without children, a callback that returns an app with no typed routes is an error
{
  const ctx = defineRootContext('/api', []);
  const makeRouter = createRouter();

  expectTypeOf<
    CheckCallbackResult<OpenAPIHono<{ Variables: {} }>>
  >().toEqualTypeOf<'The callback returns an app with no typed routes. Return the .openapi() chain, or return nothing.'>();
  expectTypeOf<CheckCallbackResult<OpenAPIHono<any, any, any>>>().toEqualTypeOf<unknown>();
  expectTypeOf<CheckCallbackResult<{ custom: true }>>().toEqualTypeOf<unknown>();

  // @ts-expect-error the callback returns an app with no typed routes
  makeRouter(ctx, ({ app, defineRoute }) => {
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    );

    return app;
  });

  // @ts-expect-error also for `app` returned directly
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

// With children, the callback must return a router or nothing. `children` is optional
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

  expectTypeOf(makeRouter(ctx, () => {}, [child])()).toEqualTypeOf<Router>();

  // As the runtime `result ?? router`.
  const flag = Math.random() > 0.5;
  expectTypeOf(
    makeRouter(ctx, ({ app }) => {
      if (flag) {
        return app;
      }
    })(),
  ).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, () => null)()).toEqualTypeOf<Router>();
  expectTypeOf(makeRouter(ctx, () => (flag ? { x: 1 } : undefined))()).toEqualTypeOf<
    { x: number } | Router
  >();

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

  // @ts-expect-error children mount on the result of the factory, which must be a router
  makeRouter(ctx, () => ({ not: 'router' }), [child]);

  expectTypeOf(makeRouter(ctx, () => ({ not: 'router' as const }))()).toEqualTypeOf<{
    not: 'router';
  }>();
}

// Hooks get `RouteMeta` as a second argument. A hook with one argument also compiles
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

// A route middleware factory can return `undefined`
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

// Context bindings type `c.env` in each route handler. No bindings give no `Bindings`
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

  const explicit = defineRootContext<'/api', {}, Bindings>('/api').middleware(session);
  makeRouter(explicit, ({ app }) => {
    expectTypeOf(app).toEqualTypeOf<
      OpenAPIHono<{ Bindings: Bindings; Variables: {} & SessionVars }>
    >();
  });
}

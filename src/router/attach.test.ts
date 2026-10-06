import { inspectRoutes } from 'hono/dev';
import type { Context, MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonResponse } from '../schema-helpers';
import { createRouter } from './create-router';
import { mountRouter } from './mount';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

describe('route middleware attaches at openapi', () => {
  const root = defineRootContext('/api', []);
  const things = defineChildContext(root, '/things');
  const other = defineChildContext(root, '/other');

  function named(name: string): MiddlewareHandler {
    const mw: MiddlewareHandler = async (_c, next) => {
      await next();
    };

    Object.defineProperty(mw, 'name', { value: name });

    return mw;
  }

  it('throws for a createRoute config in a router with options', () => {
    const cases: [Parameters<typeof createRouter>[0], string][] = [
      [{ routeMiddleware: () => named('policy') }, 'routeMiddleware'],
      [{ routeDefaults: { tags: ['api'] } }, 'routeDefaults'],
      [{ transformRoute: (route) => route }, 'transformRoute'],
      [{ routeDefaults: { tags: ['api'] }, routeMiddleware: [] }, 'routeDefaults'],
      [
        { transformRoute: (route) => route, routeMiddleware: [() => undefined] },
        'transformRoute, routeMiddleware',
      ],
    ];

    for (const [options, name] of cases) {
      const raw = createRoute({ method: 'post', path: '/', responses: { 200: okResponse } });

      const router = createRouter(options)(things, ({ app }) =>
        app.openapi(raw, (c) => c.json({ ok: true }, 200)),
      );

      const named = name.includes(',') ? `${name} options do` : `${name} option does`;

      expect(() => mountRouter(root, [router])).toThrow(TypeError);
      expect(() => mountRouter(root, [router])).toThrow(
        new TypeError(
          `hono-typed-router: openapi: the POST route at '/api/things' was not declared with the defineRoute() of this router, so its ${named} not apply. Declare it with defineRoute(method, config) inside this callback.`,
        ),
      );
    }
  });

  it('accepts a createRoute config when no option changes a route', async () => {
    const cases: Parameters<typeof createRouter>[0][] = [
      { routeDefaults: {} },
      { routeMiddleware: [] },
      { routeDefaults: {}, routeMiddleware: [] },
    ];

    const statuses = cases.map(async (options) => {
      const raw = createRoute({ method: 'get', path: '/', responses: { 200: okResponse } });

      const router = createRouter(options)(things, ({ app }) =>
        app.openapi(raw, (c) => c.json({ ok: true }, 200)),
      );

      return (await mountRouter(root, [router]).request('/api/things')).status;
    });

    expect(await Promise.all(statuses)).toEqual([200, 200, 200]);
  });

  it('throws when the callback returns another app and a route middleware was not attached', () => {
    const makeRouter = createRouter({ routeMiddleware: () => named('policy') });

    const returns: [string, (app: OpenAPIHono<any, any, any>) => OpenAPIHono][] = [
      ["app.basePath('/')", (app) => app.basePath('/')],
      ["app.basePath('/x')", (app) => app.basePath('/x')],
      ['new OpenAPIHono()', () => new OpenAPIHono()],
    ];

    for (const [label, other] of returns) {
      const router = makeRouter(things, ({ app, defineRoute }) => {
        const r = defineRoute('get', { responses: { 200: okResponse } });
        const target = other(app);

        return target.openapi(r, (c) => c.json({ ok: true }, 200));
      });

      expect(router, label).toThrow(TypeError);
      expect(router, label).toThrow(
        new TypeError(
          "hono-typed-router: makeRouter: the GET route at '/api/things' has route middlewares that were not attached, because the callback returned a different app. Return the app that the callback received, or register the routes on it.",
        ),
      );
    }
  });

  it('accepts another returned app when every route middleware was attached', async () => {
    const makeRouter = createRouter({ routeMiddleware: () => named('policy') });

    const registered = makeRouter(things, ({ app, defineRoute }) =>
      app
        .openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        )
        .basePath('/x'),
    );

    expect((await registered().request('/things')).status).toBe(200);

    // An app with an `any` schema passes the type check of the callback result.
    expect(makeRouter(things, () => new OpenAPIHono<any, any, any>())).not.toThrow();

    const noMiddleware = createRouter({ routeMiddleware: () => undefined })(
      things,
      ({ app, defineRoute }) =>
        app
          .basePath('/')
          .openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
            c.json({ ok: true }, 200),
          ),
    );

    expect((await noMiddleware().request('/things')).status).toBe(200);
  });

  it('mounts the children on the router when the factory returns nothing', async () => {
    const makeRouter = createRouter({ routeMiddleware: () => named('policy') });

    const app = makeRouter(
      root,
      ({ app, defineRoute }) => {
        app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        );
      },
      [
        makeRouter(things, ({ app, defineRoute }) =>
          app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
            c.json({ ok: true }, 200),
          ),
        ),
      ],
    )();

    expect(inspectRoutes(app).filter((r) => r.name === 'policy')).toHaveLength(2);
    expect((await app.request('/api/things')).status).toBe(200);
  });

  it('throws for a config from the defineRoute of another router', () => {
    const makeRouter = createRouter({ routeMiddleware: () => named('policy') });
    let leaked: unknown;

    const a = makeRouter(things, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      leaked = r;

      return app.openapi(r, (c) => c.json({ ok: true }, 200));
    });

    const b = makeRouter(
      other,
      ({ app }) => void app.openapi(leaked as never, (c) => c.json({ ok: true }, 200) as never),
    );

    expect(() => mountRouter(root, [a, b])).toThrow(TypeError);
    expect(() => mountRouter(root, [a, b])).toThrow(
      new TypeError(
        'hono-typed-router: openapi: the GET route was declared by the defineRoute() of another router. Its route middlewares were built for that router. Declare it with defineRoute(method, config) inside this callback.',
      ),
    );
  });

  it('throws when a router without options registers a config from a router with route middleware', () => {
    let leaked: unknown;

    const a = createRouter({ routeMiddleware: () => named('policy') })(
      things,
      ({ defineRoute }) => {
        leaked = defineRoute('get', { responses: { 200: okResponse } });
      },
    );

    const b = createRouter()(
      other,
      ({ app }) => void app.openapi(leaked as never, (c) => c.json({ ok: true }, 200) as never),
    );

    expect(() => mountRouter(root, [a, b])).toThrow(/another router/);
  });

  it('attaches nothing for a route that is declared but not registered', async () => {
    const calls: string[] = [];

    const makeRouter = createRouter({
      routeMiddleware: (route) => {
        calls.push(route.method);

        return named(`policy:${route.method}`);
      },
    });

    const router = makeRouter(things, ({ app, defineRoute }) => {
      defineRoute('delete', { responses: { 200: okResponse } });

      return app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      );
    });

    const app = mountRouter(root, [router]);
    const policies = inspectRoutes(app).filter((r) => r.name.startsWith('policy:'));

    // `defineRoute` still builds the middlewares of both routes.
    expect(calls).toEqual(['delete', 'get']);
    expect(policies.map((r) => `${r.method} ${r.name}`)).toEqual(['GET policy:get']);
    expect((await app.request('/api/things', { method: 'DELETE' })).status).toBe(404);
  });

  it('accepts a createRoute config in a router without options', async () => {
    const router = createRouter()(other, ({ app }) =>
      app.openapi(createRoute({ method: 'get', path: '/', responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

    expect((await mountRouter(root, [router]).request('/api/other')).status).toBe(200);
  });

  it('attaches the middlewares once when a route is registered twice', () => {
    const app = createRouter({ routeMiddleware: () => named('policy') })(
      things,
      ({ app, defineRoute }) => {
        const r = defineRoute('get', { responses: { 200: okResponse } });

        return app
          .openapi(r, (c) => c.json({ ok: true }, 200))
          .openapi(r, (c) => c.json({ ok: true }, 200));
      },
    )();

    expect(inspectRoutes(app).filter((r) => r.name === 'policy')).toHaveLength(1);
  });

  it('attaches the middlewares for routes registered with openapiRoutes', async () => {
    const app = createRouter({ routeMiddleware: () => async (c) => c.json({ ok: false }, 403) })(
      things,
      ({ app, defineRoute }) =>
        app.openapiRoutes([
          {
            route: defineRoute('get', { responses: { 200: okResponse } }),
            handler: (c: Context) => c.json({ ok: true }, 200),
          },
        ] as const),
    )();

    expect((await app.request('/things')).status).toBe(403);
  });

  it('runs a middleware that the factory adds with app.use before the route middleware', async () => {
    const order: string[] = [];

    const app = createRouter({
      routeMiddleware: () => async (_c, next) => {
        order.push('policy');
        await next();
      },
    })(things, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.use(async (_c, next) => {
        order.push('use');
        await next();
      });

      return app.openapi(r, (c) => c.json({ ok: true }, 200));
    })();

    await app.request('/things');
    expect(order).toEqual(['use', 'policy']);
  });

  it('registers no middleware when every factory returns undefined', async () => {
    const app = createRouter({
      routeMiddleware: [
        () => undefined,
        (route) => (route.method === 'post' ? named('onlyPost') : undefined),
      ],
    })(things, ({ app, defineRoute }) =>
      app
        .openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        )
        .openapi(defineRoute('post', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        ),
    )();

    const routes = inspectRoutes(app).map((r) => `${r.method} ${r.name}`);

    expect(routes.filter((r) => r.startsWith('GET'))).toHaveLength(1);
    expect(routes).toContain('POST onlyPost');
    expect((await app.request('/things')).status).toBe(200);
  });

  it('hides a route that sets hide in defineRoute', async () => {
    const app = createRouter({ routeMiddleware: () => named('policy') })(
      things,
      ({ app, defineRoute }) =>
        app.openapi(defineRoute('get', { hide: true, responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        ),
    )();

    const doc = app.getOpenAPIDocument({ openapi: '3.0.0', info: { title: 't', version: '1' } });

    expect(doc.paths).toEqual({});
    expect((await app.request('/things')).status).toBe(200);
  });

  it('throws for a copy of a declared config in a router with options', () => {
    const router = createRouter({ routeMiddleware: () => named('policy') })(
      things,
      ({ app, defineRoute }) => {
        const r = defineRoute('get', { responses: { 200: okResponse } });

        return app.openapi({ ...r, hide: true }, (c) => c.json({ ok: true }, 200));
      },
    );

    expect(router).toThrow(/was not declared with the defineRoute\(\) of this router/);
  });

  it('passes the same app as the deprecated router key', () => {
    let same = false;

    createRouter()(things, ({ app, router }) => {
      same = app === router;
    })();

    expect(same).toBe(true);
  });
});

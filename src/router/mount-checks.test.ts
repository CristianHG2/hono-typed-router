import { describe, expect, it } from 'vitest';
import { createRoute, z, type OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import { inspectRoutes } from 'hono/dev';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonResponse } from '../factories';
import { registeredRoutes } from './attach';
import { createRouter } from './lib';
import { mountRouter } from './mount';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const makeRouter = createRouter();

type Method = 'get' | 'post' | 'head';

// A router with one route for each method, at the context path or at `path`.
const routes = (ctx: Parameters<typeof makeRouter>[0], methods: Method[], path = '/') =>
  makeRouter(ctx, ({ app, defineRoute }) => {
    for (const method of methods) {
      app.openapi(defineRoute(method, { path, responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      );
    }
  });

const pass = async (_c: unknown, next: () => Promise<void>) => {
  await next();
};

describe('duplicate routes', () => {
  const root = defineRootContext('/api', []);
  const a = defineChildContext<typeof root>()('/things');
  const b = defineChildContext<typeof root>()('/things');

  it('throws when two children declare the same method and path', () => {
    const build = () => makeRouter(root, () => {}, [routes(a, ['get']), routes(b, ['get'])])();

    expect(build).toThrow(TypeError);
    expect(build).toThrow(
      new TypeError(
        "hono-typed-router: makeRouter: two children declare GET '/api/things'. The client type of that path can become never. Declare each method and path once.",
      ),
    );
  });

  it('throws for a repeat in a grandchild, with the full path', () => {
    const things = defineChildContext(root, '/things');
    const item = defineChildContext(things, '/:id');
    const nested = makeRouter(things, () => {}, [routes(item, ['get'])]);

    expect(() => makeRouter(root, () => {}, [nested, routes(b, ['get'], '/{id}')])()).toThrow(
      "two children declare GET '/api/things/:id'",
    );
  });

  it('accepts the same path with different methods', async () => {
    const app = makeRouter(root, () => {}, [routes(a, ['get']), routes(b, ['post'])])();

    expect((await app.request('/api/things', { method: 'POST' })).status).toBe(200);
  });

  it('throws when the callback declares the same route twice', () => {
    expect(routes(root, ['get', 'get'])).toThrow(
      new TypeError(
        "hono-typed-router: makeRouter: the callback declares GET '/api' twice. The client type of that path can become never. Declare each method and path once.",
      ),
    );
  });

  it('throws when the callback and a child declare the same route', () => {
    const withChild = makeRouter(
      root,
      ({ app, defineRoute }) => {
        const route = defineRoute('get', { path: '/things', responses: { 200: okResponse } });

        // The handler type is `never`: the client type of the route is already wrong.
        app.openapi(route, (c) => c.json({ ok: true }, 200) as never);
      },
      [routes(a, ['get'])],
    );

    expect(withChild).toThrow(
      "hono-typed-router: makeRouter: the callback and a child both declare GET '/api/things'.",
    );
  });

  it('accepts a route that the callback registers twice', () => {
    const router = makeRouter(root, ({ app, defineRoute }) => {
      const route = defineRoute('get', { responses: { 200: okResponse } });

      app.openapi(route, (c) => c.json({ ok: true }, 200));
      app.openapi(route, (c) => c.json({ ok: true }, 200));
    });

    expect(router).not.toThrow();
  });

  it('throws through mountRouter', () => {
    expect(() => mountRouter(root, [routes(a, ['get']), routes(b, ['get'])])).toThrow(
      "hono-typed-router: mountRouter: two children declare GET '/api/things'.",
    );
  });

  it('throws for the same path with a different param name', () => {
    const one = defineChildContext(root, '/a/:id');
    const two = defineChildContext(root, '/a/:x');

    expect(() =>
      makeRouter(root, () => {}, [routes(one, ['get']), routes(two, ['get'])])(),
    ).toThrow(
      new TypeError(
        "hono-typed-router: makeRouter: two children declare GET '/api/a/:id' and GET '/api/a/:x' (the same path with a different param name). Hono gives every request to the first route. Declare each method and path once.",
      ),
    );
  });

  it('throws when the callback declares a path twice with different param names', () => {
    const router = makeRouter(root, ({ app, defineRoute }) => {
      // The handler types are `never`: the client type of the path is already wrong.
      app.openapi(
        defineRoute('get', { path: '/{id}', responses: { 200: okResponse } }),
        (c) => c.json({ ok: true }, 200) as never,
      );
      app.openapi(
        defineRoute('get', { path: '/{key}', responses: { 200: okResponse } }),
        (c) => c.json({ ok: true }, 200) as never,
      );
    });

    expect(router).toThrow(
      "the callback declares GET '/api/:id' and GET '/api/:key' (the same path with a different param name).",
    );
  });

  it('accepts params with different regexes', () => {
    const numeric = defineChildContext(root, '/a/:id{[0-9]+}');
    const named = defineChildContext(root, '/a/:slug{[a-z]+}');

    expect(
      makeRouter(root, () => {}, [routes(numeric, ['get']), routes(named, ['get'])]),
    ).not.toThrow();
  });

  it('accepts a path with and without a trailing slash, as Hono routes them apart', async () => {
    const slash = defineChildContext(root, '/things/');
    const app = makeRouter(root, () => {}, [routes(a, ['get']), routes(slash, ['get'])])();

    expect((await app.request('/api/things')).status).toBe(200);
    expect((await app.request('/api/things/')).status).toBe(200);
  });
});

describe("duplicate routes under a child at the segment '/' or ''", () => {
  const root = defineRootContext('/api', []);

  const parentRoute = (
    ctx: Parameters<typeof makeRouter>[0],
    children: Parameters<typeof makeRouter>[2],
  ) =>
    makeRouter(
      ctx,
      ({ app, defineRoute }) => {
        app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        );
      },
      children,
    );

  it('serves the routes of a value-form child at the parent path, where the keys say', async () => {
    const child = defineChildContext(root, '/');
    const app = makeRouter(root, () => {}, [routes(child, ['get'])])();

    expect(child.path).toBe('/api');
    expect(inspectRoutes(app).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api']);
    expect((await app.request('/api')).status).toBe(200);
  });

  it('throws when the callback and a value-form child both declare the parent path', () => {
    const child = defineChildContext(root, '/');

    expect(parentRoute(root, [routes(child, ['get'])])).toThrow(
      "hono-typed-router: makeRouter: the callback and a child both declare GET '/api'.",
    );
  });

  it('throws when the callback and a curried child both declare the parent path', () => {
    const child = defineChildContext<typeof root>()('/');

    expect(parentRoute(root, [routes(child, ['get'])])).toThrow(
      "hono-typed-router: makeRouter: the callback and a child both declare GET '/api'.",
    );
  });

  it("throws for children at '/' and ''", () => {
    const slash = defineChildContext(root, '/');
    const empty = defineChildContext(root, '');

    expect(makeRouter(root, () => {}, [routes(slash, ['get']), routes(empty, ['get'])])).toThrow(
      "hono-typed-router: makeRouter: two children declare GET '/api'.",
    );
  });

  it("throws for a grandchild at '/' under a child at '/' and the callback", () => {
    const child = defineChildContext(root, '/');
    const grandchild = defineChildContext(child, '/');
    const nested = makeRouter(child, () => {}, [routes(grandchild, ['get'])]);

    expect(parentRoute(root, [nested])).toThrow(
      "hono-typed-router: makeRouter: the callback and a child both declare GET '/api'.",
    );
  });

  it("throws for a route '/x' of a child at '/' and a child at '/x'", () => {
    const slash = defineChildContext(root, '/');
    const x = defineChildContext(root, '/x');

    expect(makeRouter(root, () => {}, [routes(slash, ['get'], '/x'), routes(x, ['get'])])).toThrow(
      "hono-typed-router: makeRouter: two children declare GET '/api/x'.",
    );
  });

  it("throws when the callback and a route '' of a child at '/' both declare the parent path", async () => {
    const child = defineChildContext(root, '/');

    expect(parentRoute(root, [routes(child, ['get'], '')])).toThrow(
      "hono-typed-router: makeRouter: the callback and a child both declare GET '/api'.",
    );

    const app = makeRouter(root, () => {}, [routes(child, ['get'], '')])();

    expect(inspectRoutes(app).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api']);
  });

  it("keeps the trailing slash of a root '/api/' for a child at '/'", async () => {
    const slashRoot = defineRootContext('/api/', []);
    const child = defineChildContext(slashRoot, '/');

    expect(child.path).toBe('/api/');
    expect(parentRoute(slashRoot, [routes(child, ['get'])])).toThrow(
      "hono-typed-router: makeRouter: the callback and a child both declare GET '/api/'.",
    );

    const app = makeRouter(slashRoot, () => {}, [routes(child, ['get'])])();

    expect((await app.request('/api/')).status).toBe(200);
  });
});

describe('children order', () => {
  const root = defineRootContext('/api', []);
  const byId = defineChildContext(root, '/:id');
  const stats = defineChildContext(root, '/stats');

  const message =
    "hono-typed-router: makeRouter: the child '/:id' is mounted before '/stats'. Hono matches in registration order, so '/:id' gets the requests to GET '/api/stats'. Put children with literal segments first.";

  it('throws for a param child before a literal sibling', () => {
    const build = () =>
      makeRouter(root, () => {}, [routes(byId, ['get']), routes(stats, ['get'])])();

    expect(build).toThrow(TypeError);
    expect(build).toThrow(message);
  });

  it('accepts literal children first', async () => {
    const app = makeRouter(root, () => {}, [routes(stats, ['get']), routes(byId, ['get'])])();

    expect((await app.request('/api/stats')).status).toBe(200);
  });

  it('accepts two param children', () => {
    const bySlug = defineChildContext(root, '/:slug');

    expect(
      makeRouter(root, () => {}, [routes(byId, ['get']), routes(bySlug, ['post'])]),
    ).not.toThrow();
  });

  it('accepts the order when the param child has no middlewares and no method in common', () => {
    expect(
      makeRouter(root, () => {}, [routes(byId, ['post']), routes(stats, ['get'])]),
    ).not.toThrow();
  });

  it('throws when the param child has middlewares of its own, such as a .bind() loader', () => {
    const bound = byId.bind('thing', 'id', () => ({ id: 1 }));

    expect(makeRouter(root, () => {}, [routes(bound, ['post']), routes(stats, ['get'])])).toThrow(
      message,
    );
    expect(
      makeRouter(root, () => {}, [routes(byId.middleware(pass), []), routes(stats, ['get'])]),
    ).toThrow(message);
  });

  it('counts HEAD as GET', () => {
    expect(makeRouter(root, () => {}, [routes(byId, ['head']), routes(stats, ['get'])])).toThrow(
      message,
    );
  });

  it('accepts a regex param that does not match the literal segment', () => {
    const numeric = defineChildContext(root, '/:id{[0-9]+}');

    expect(
      makeRouter(root, () => {}, [routes(numeric, ['get']), routes(stats, ['get'])]),
    ).not.toThrow();
  });

  it('throws through mountRouter', () => {
    expect(() => mountRouter(root, [routes(byId, ['get']), routes(stats, ['get'])])).toThrow(
      message.replace('makeRouter', 'mountRouter'),
    );
  });

  // `/stats` with `GET /x`: the message names that route.
  const statsX = () => routes(stats, ['get'], '/x');

  const nested = (prefix: string, tail: string) =>
    `the child '/:id' is mounted before '/stats'. Hono matches in registration order, so '/:id' gets the requests to GET '/api/stats${tail}'. ${prefix}`;

  it('accepts a param route that matches no sibling route', async () => {
    // `GET /:id` vs `GET /stats/x`, and `GET /:id/sub` vs `GET /stats`.
    const one = makeRouter(root, () => {}, [routes(byId, ['get']), statsX()])();

    const two = makeRouter(root, () => {}, [
      routes(byId, ['get'], '/sub'),
      routes(stats, ['get']),
    ])();

    expect((await one.request('/api/stats/x')).status).toBe(200);
    expect((await two.request('/api/stats')).status).toBe(200);
  });

  it('names the sibling route that the param child gets', () => {
    expect(makeRouter(root, () => {}, [routes(byId, ['get'], '/x'), statsX()])).toThrow(
      nested('Put children with literal segments first.', '/x'),
    );
  });

  it('throws when a descendant of the param child has middlewares', () => {
    // Else the grandchild middleware runs for `GET /api/stats/x`.
    const sub = defineChildContext(byId, '/x').middleware(pass);
    const parent = makeRouter(byId, () => {}, [routes(sub, ['post'])]);

    expect(makeRouter(root, () => {}, [parent, statsX()])).toThrow(nested('Put children', '/x'));
  });

  it('throws when the param child calls app.use()', () => {
    // Else the `use` middleware runs for `GET /api/stats`.
    const withUse = makeRouter(byId, ({ app, defineRoute }) => {
      app.use(pass);
      app.openapi(defineRoute('post', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      );
    });

    expect(makeRouter(root, () => {}, [withUse, routes(stats, ['get'])])).toThrow(
      new TypeError(message),
    );
  });

  it('throws when the param child has a route that defineRoute did not declare', () => {
    // Else the raw `GET /:id` route gets `GET /api/stats`.
    const raw = makeRouter(byId, ({ app, defineRoute }) => {
      app.get('/', (c) => c.text('raw'));
      app.openapi(defineRoute('post', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      );
    });

    expect(makeRouter(root, () => {}, [raw, routes(stats, ['get'])])).toThrow(message);
  });

  it('throws for a raw route even when its path matches no sibling route', () => {
    // `GET /:id/sub` gets no request of `GET /stats`, but the check does not read raw routes.
    const raw = makeRouter(byId, ({ app }) => {
      app.get('/sub', (c) => c.text('raw'));
    });

    expect(makeRouter(root, () => {}, [raw, routes(stats, ['get'])])).toThrow(message);
  });
});

describe('duplicate routes with createRoute configs', () => {
  const root = defineRootContext('/api', []);
  const a = defineChildContext<typeof root>()('/things');
  const b = defineChildContext<typeof root>()('/things');

  // SAFETY: the registry keys apps by identity. The env type of the app has no effect.
  const recorded = (app: unknown) => registeredRoutes(app as OpenAPIHono);

  const rawGet = (path = '/') =>
    createRoute({ method: 'get', path, responses: { 200: okResponse } });

  // A router that registers `config` with `app.openapi`, as the callback gives it.
  const withRaw = (ctx: Parameters<typeof makeRouter>[0], config: RouteConfig) =>
    makeRouter(ctx, ({ app }) => {
      app.openapi(config, (c) => c.json({ ok: true }, 200) as never);
    });

  it('throws when two children register the same createRoute config', () => {
    const build = () => makeRouter(root, () => {}, [withRaw(a, rawGet()), withRaw(b, rawGet())])();

    expect(build).toThrow(TypeError);
    expect(build).toThrow(
      new TypeError(
        "hono-typed-router: makeRouter: two children declare GET '/api/things'. The client type of that path can become never. Declare each method and path once.",
      ),
    );
  });

  it('throws when a createRoute config in the callback and a defineRoute route in a child collide', () => {
    const parent = makeRouter(
      root,
      ({ app }) => {
        app.openapi(rawGet('/things'), (c) => c.json({ ok: true }, 200) as never);
      },
      [routes(a, ['get'])],
    );

    expect(parent).toThrow(TypeError);
    expect(parent).toThrow(
      new TypeError(
        "hono-typed-router: makeRouter: the callback and a child both declare GET '/api/things'. The client type of that path can become never. Declare each method and path once.",
      ),
    );
  });

  it('throws when a defineRoute route in the callback and a createRoute config in a child collide', () => {
    const parent = makeRouter(
      root,
      ({ app, defineRoute }) => {
        const route = defineRoute('get', { path: '/things', responses: { 200: okResponse } });

        app.openapi(route, (c) => c.json({ ok: true }, 200) as never);
      },
      [withRaw(a, rawGet())],
    );

    expect(parent).toThrow(TypeError);
    expect(parent).toThrow(
      "hono-typed-router: makeRouter: the callback and a child both declare GET '/api/things'.",
    );
  });

  it('records one createRoute config that the callback registers twice as one route', () => {
    const raw = rawGet();

    const app = makeRouter(root, ({ app }) => {
      app.openapi(raw, (c) => c.json({ ok: true }, 200) as never);
      app.openapi(raw, (c) => c.json({ ok: true }, 200) as never);
    })();

    expect(recorded(app)).toEqual([{ route: raw, declared: false }]);
  });

  it('throws when the callback registers two createRoute configs with the same method and path', () => {
    const router = makeRouter(root, ({ app }) => {
      app.openapi(rawGet(), (c) => c.json({ ok: true }, 200) as never);
      app.openapi(rawGet(), (c) => c.json({ ok: true }, 200) as never);
    });

    expect(router).toThrow(TypeError);
    expect(router).toThrow(
      new TypeError(
        "hono-typed-router: makeRouter: the callback declares GET '/api' twice. The client type of that path can become never. Declare each method and path once.",
      ),
    );
  });

  it('records a foreign config that the callback registers twice as one route', () => {
    let foreign: RouteConfig | undefined;

    makeRouter(a, ({ defineRoute }) => {
      foreign = defineRoute('get', { responses: { 200: okResponse } });
    })();

    const config = foreign!;

    const app = makeRouter(b, ({ app }) => {
      app.openapi(config, (c) => c.json({ ok: true }, 200) as never);
      app.openapi(config, (c) => c.json({ ok: true }, 200) as never);
    })();

    expect(recorded(app)).toEqual([{ route: config, declared: false }]);
  });

  it('records a config from the defineRoute of another router on the router that registers it', () => {
    let foreign: RouteConfig | undefined;

    // The router that declares the config does not register it.
    makeRouter(a, ({ defineRoute }) => {
      foreign = defineRoute('get', { responses: { 200: okResponse } });
    })();

    const config = foreign!;
    const app = withRaw(b, config)();

    expect(recorded(app)).toEqual([{ route: config, declared: false }]);

    const parent = makeRouter(root, () => {}, [withRaw(b, config), routes(a, ['get'])]);

    expect(parent).toThrow(TypeError);
    expect(parent).toThrow(
      "hono-typed-router: makeRouter: two children declare GET '/api/things'.",
    );
  });

  it('does not record the routes of a child on the parent', () => {
    const child = defineChildContext(root, '/a');
    const raw = rawGet('/a/x');
    let parentApp: unknown;

    const app = makeRouter(
      root,
      ({ app }) => {
        parentApp = app;
        app.openapi(raw, (c) => c.json({ ok: true }, 200) as never);
      },
      [routes(child, ['get'], '/y')],
    )();

    expect(app).toBe(parentApp);
    expect(recorded(app).map(({ route }) => route)).toEqual([raw]);
  });

  it('throws through mountRouter', () => {
    const build = () => mountRouter(root, [withRaw(a, rawGet()), withRaw(b, rawGet())]);

    expect(build).toThrow(TypeError);
    expect(build).toThrow(
      "hono-typed-router: mountRouter: two children declare GET '/api/things'.",
    );
  });
});

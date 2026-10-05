import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonResponse } from '../factories';
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
        "hono-typed-router: makeRouter: two children declare GET '/api/things'. The client type of that path becomes never. Declare each method and path once.",
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
        "hono-typed-router: makeRouter: the callback declares GET '/api' twice. The client type of that path becomes never. Declare each method and path once.",
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
    // G1: the grandchild middleware would run for `GET /api/stats/x`.
    const sub = defineChildContext(byId, '/x').middleware(pass);
    const parent = makeRouter(byId, () => {}, [routes(sub, ['post'])]);

    expect(makeRouter(root, () => {}, [parent, statsX()])).toThrow(nested('Put children', '/x'));
  });

  it('throws when the param child calls app.use()', () => {
    // G2: the `use` middleware would run for `GET /api/stats`.
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
    // G5: the raw `GET /:id` route would get `GET /api/stats`.
    const raw = makeRouter(byId, ({ app, defineRoute }) => {
      app.get('/', (c) => c.text('raw'));
      app.openapi(defineRoute('post', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      );
    });

    expect(makeRouter(root, () => {}, [raw, routes(stats, ['get'])])).toThrow(message);
  });

  it('throws for a raw route even when its path matches no sibling route', () => {
    // `GET /:id/sub` gets no request of `GET /stats`, but the router does not follow raw routes.
    const raw = makeRouter(byId, ({ app }) => {
      app.get('/sub', (c) => c.text('raw'));
    });

    expect(makeRouter(root, () => {}, [raw, routes(stats, ['get'])])).toThrow(message);
  });
});

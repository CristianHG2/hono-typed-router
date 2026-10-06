import { inspectRoutes } from 'hono/dev';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import {
  defineChildContext,
  defineChildRoute,
  defineRootContext,
  defineRootRoute,
  extendRouteContext,
} from '../definitions';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from '../definitions';
import { getRouteIdentity } from '../definitions/define-context';
import { jsonResponse } from '../schema-helpers';
import { createRouter } from './create-router';
import { mountRouter } from './mount';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

describe('createRouter children', () => {
  it('passes meta.path from a directly called thunk: the full path for a value-form child, the segment for a curried one', () => {
    const seen: string[] = [];
    const root = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeMiddleware: (route, meta) => {
        seen.push(`${route.method} ${route.path} ${meta.path}`);

        return async (_c, next) => {
          await next();
        };
      },
    });

    function build(ctx: Parameters<typeof makeRouter>[0]) {
      return makeRouter(ctx, ({ defineRoute }) => {
        defineRoute('get', { responses: { 200: okResponse } });
      })();
    }

    build(defineChildContext(root, '/things'));
    build(defineChildContext<typeof root>()('/things'));
    build(defineRootContext('', []));
    build(defineChildContext(root, '/'));

    expect(seen).toEqual(['get / /api/things', 'get / /things', 'get / /', 'get / /api']);
  });

  it('passes the full mounted path as meta.path for curried children and grandchildren', async () => {
    const seen: string[] = [];
    const root = defineRootContext('/api', []);
    const things = defineChildContext<typeof root>()('/things');
    const thing = defineChildContext<typeof things>()('/:id');

    const makeRouter = createRouter({
      routeMiddleware: (_route, meta) => {
        seen.push(meta.path);

        return async (_c, next) => {
          await next();
        };
      },
    });

    const thingRouter = makeRouter(thing, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

    const thingsRouter = makeRouter(
      things,
      ({ app, defineRoute }) =>
        app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        ),
      [thingRouter],
    );

    const app = makeRouter(root, () => {}, [thingsRouter])();

    expect(seen).toEqual(['/api/things', '/api/things/:id']);
    expect((await app.request('/api/things')).status).toBe(200);
    expect((await app.request('/api/things/1')).status).toBe(200);

    const paths = inspectRoutes(app)
      .filter((r) => !r.isMiddleware)
      .map((r) => r.path);

    expect(paths).toEqual(['/api/things', '/api/things/:id']);

    seen.length = 0;
    thingsRouter();
    expect(seen).toEqual(['/things', '/things/:id']);
  });

  it('gives transformRoute the full mounted path of a curried child', () => {
    const operationIds: unknown[] = [];
    const root = defineRootContext('/api', []);
    const things = defineChildContext<typeof root>()('/things');

    const makeRouter = createRouter({
      transformRoute: (route, meta) => ({
        ...route,
        operationId: `${route.method}${meta.path.replaceAll(/[/:]+/g, '_')}`,
      }),
      routeMiddleware: (route) => {
        operationIds.push(route.operationId);

        return async (_c, next) => {
          await next();
        };
      },
    });

    const thingsRouter = makeRouter(things, ({ defineRoute }) => {
      defineRoute('get', { responses: { 200: okResponse } });
      defineRoute('post', { path: '/{id}', responses: { 200: okResponse } } as never);
    });

    makeRouter(root, () => {}, [thingsRouter])();

    expect(operationIds).toEqual(['get_api_things', 'post_api_things_id']);
  });

  it('normalizes meta.path to Hono :param syntax and never doubles slashes', () => {
    const seen: string[] = [];

    const makeRouter = createRouter({
      routeMiddleware: (_route, meta) => {
        seen.push(meta.path);

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(defineChildContext(defineRootContext('/', []), '/things'), ({ defineRoute }) => {
      // The typed input has no `path`, so a cast declares `{param}`.
      defineRoute('get', { path: '/{id}', responses: { 200: okResponse } } as never);
    })();
    makeRouter(defineRootContext('/', []), ({ defineRoute }) => {
      defineRoute('get', { path: '/x', responses: { 200: okResponse } } as never);
    })();

    expect(seen).toEqual(['/things/:id', '/x']);
  });

  it('joins a value-form child of a root `/` without a double slash and mounts it once', async () => {
    const root = defineRootContext('/', []);
    const things = defineChildContext(root, '/things');
    expect(things.path).toBe('/things');
    expect(defineChildContext(things, '/:id').path).toBe('/things/:id');
    expect(defineChildContext(defineRootContext('', []), '/things').path).toBe('/things');
    expect(defineChildContext(defineRootContext('/api/', []), '/x').path).toBe('/api/x');

    const makeRouter = createRouter();

    const thingsRouter = makeRouter(things, ({ app, defineRoute }) => {
      const list = defineRoute('get', { responses: { 200: okResponse } });
      expect(list.path).toBe('/');
      app.openapi(list, (c) => c.json({ ok: true }, 200));
    });

    const app = makeRouter(root, () => {}, [thingsRouter])();

    expect((await app.request('/things')).status).toBe(200);

    const paths = inspectRoutes(app)
      .filter((r) => !r.isMiddleware)
      .map((r) => r.path);

    expect(paths).toEqual(['/things']);
  });

  it('joins a child segment without a leading `/` with one and serves it where meta.path says', async () => {
    const root = defineRootContext('/api', []);
    const x = defineChildContext(root, 'x');
    expect(x.path).toBe('/api/x');
    expect(defineChildContext(x, 'y').path).toBe('/api/x/y');
    expect(defineChildContext(defineRootContext('', []), 'x').path).toBe('/x');
    expect(defineChildContext(root, '').path).toBe('/api');

    const seen: string[] = [];

    const makeRouter = createRouter({
      routeMiddleware: [
        (_route, meta) => async (_c, next) => {
          seen.push(meta.path);
          await next();
        },
      ],
    });

    const xRouter = makeRouter(x, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

    const app = makeRouter(root, () => {}, [xRouter])();

    expect((await app.request('/api/x')).status).toBe(200);
    expect((await app.request('/apix')).status).toBe(404);
    expect(seen).toEqual(['/api/x']);

    const paths = inspectRoutes(app)
      .filter((r) => !r.isMiddleware)
      .map((r) => r.path);

    expect(paths).toEqual(['/api/x']);

    seen.length = 0;

    const slashRouter = makeRouter(defineChildContext<typeof root>()('/'), ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

    const slashApp = makeRouter(root, () => {}, [slashRouter])();

    expect((await slashApp.request('/api')).status).toBe(200);
    expect(seen).toEqual(['/api']);
  });

  it('keeps the trailing slash of a child segment in meta.path, as Hono serves it', async () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root, '/things/');
    const seen: string[] = [];

    const makeRouter = createRouter({
      routeMiddleware: (_route, meta) => {
        seen.push(meta.path);

        return undefined;
      },
    });

    const thingsRouter = makeRouter(things, ({ app, defineRoute }) => {
      for (const path of ['/', '/x']) {
        // The typed input has no `path`, so a cast declares it.
        const r = defineRoute('get', { path, responses: { 200: okResponse } } as never);
        app.openapi(r as never, (c) => c.json({ ok: true }) as never);
      }
    });

    const app = makeRouter(root, () => {}, [thingsRouter])();

    expect(seen).toEqual(['/api/things/', '/api/things/x']);
    expect(inspectRoutes(app).map((r) => r.path)).toEqual(seen);
    expect((await app.request('/api/things/')).status).toBe(200);
  });

  it('composes child routers', async () => {
    const parent = defineRootContext('/api', []);
    const child = defineChildContext<typeof parent>()('/things');
    const makeRouter = createRouter();

    const childRouter = makeRouter(child, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    });

    const root = makeRouter(parent, ({ app }) => app, [childRouter])();

    const res = await root.request('/api/things');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keeps defineRootRoute and defineChildRoute as aliases of the new functions', () => {
    expect(defineRootRoute).toBe(defineRootContext);
    expect(defineChildRoute).toBe(defineChildContext);
    expect(defineRootContext.name).toBe('defineRootContext');
    expect(defineChildContext.name).toBe('defineChildContext');

    const ext = extendRouteContext<RouteContextKind>({});
    expect(ext.defineRootRoute).toBe(ext.defineRootContext);
    expect(ext.defineChildRoute).toBe(ext.defineChildContext);
  });

  // This test uses the deprecated names on purpose. Do not change them before 2.0.

  it('composes child routers made with the deprecated names, in the value and curried forms', async () => {
    const parent = defineRootRoute('/api', []);
    const valueChild = defineChildRoute(parent, '/things');
    const curriedChild = defineChildRoute<typeof parent>()('/items');
    const makeRouter = createRouter();

    const valueRouter = makeRouter(valueChild, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    });

    const curriedRouter = makeRouter(curriedChild, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    });

    const root = makeRouter(parent, ({ app }) => app, [valueRouter, curriedRouter])();

    expect((await root.request('/api/things')).status).toBe(200);
    expect((await root.request('/api/items')).status).toBe(200);
  });

  it('mounts children when the parent factory forgets to return the router', async () => {
    const parent = defineRootContext('/api', []);
    const child = defineChildContext<typeof parent>()('/things');
    const makeRouter = createRouter();

    const childRouter = makeRouter(child, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    });

    const root = makeRouter(parent, () => {}, [childRouter])();

    const res = await root.request('/api/things');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('mounts three levels of value-form children at single-prefixed URLs', async () => {
    const root = defineRootContext('/api', []).middleware<{ user: string }>(async (c, next) => {
      c.set('user', 'u1');
      await next();
    });

    const orgs = defineChildContext(root, '/orgs');

    const org = defineChildContext(orgs, '/:orgId').middleware<{ orgId: string }>(
      async (c, next) => {
        c.set('orgId', c.req.param('orgId'));
        await next();
      },
    );

    const members = defineChildContext(org, '/members');
    const makeRouter = createRouter();

    expect(members.path).toBe('/api/orgs/:orgId/members');

    const membersRouter = makeRouter(members, ({ app, defineRoute }) => {
      const list = defineRoute('get', {
        responses: {
          200: jsonResponse(z.object({ user: z.string(), orgId: z.string() }), 'OK'),
        },
      });

      app.openapi(list, (c) => c.json({ user: c.var.user, orgId: c.var.orgId }, 200));
    });

    const orgRouter = makeRouter(org, () => {}, [membersRouter]);
    const orgsRouter = makeRouter(orgs, () => {}, [orgRouter]);
    const app = makeRouter(root, () => {}, [orgsRouter])();

    const res = await app.request('/api/orgs/o1/members');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'u1', orgId: 'o1' });
    expect((await app.request('/api/api/orgs/o1/members')).status).toBe(404);

    const paths = inspectRoutes(app).map((r) => r.path);
    expect(paths).toContain('/api/orgs/:orgId/members');
    expect(paths.some((p) => p.includes('/api/api') || p.includes('/orgs/orgs'))).toBe(false);
  });

  it('mounts a value-form child of an extended context once', async () => {
    interface Ctx<P extends string, V extends object> extends RouteContextBase<CtxKind, P, V> {
      tag: () => ReaugmentContext<CtxKind, P, V>;
    }

    interface CtxKind extends RouteContextKind {
      type: Ctx<this['path'] & string, this['vars'] & object>;
    }

    const ext = extendRouteContext<CtxKind>({ tag: (ctx) => () => ctx });
    const root = ext.defineRootContext('/api');
    const things = ext.defineChildContext(root, '/things').tag();
    const makeRouter = createRouter();

    expect(things.path).toBe('/api/things');

    const thingsRouter = makeRouter(things, ({ app, defineRoute }) => {
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      );
    });

    const app = makeRouter(root, () => {}, [thingsRouter])();
    expect((await app.request('/api/things')).status).toBe(200);
  });
});

describe('mount guard', () => {
  const makeRouter = createRouter();

  function leaf(ctx: Parameters<typeof makeRouter>[0]) {
    return makeRouter(ctx, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );
  }

  it('throws when a value-form child is mounted under a different parent context', () => {
    const root = defineRootContext('/api', []);

    const admin = defineChildContext(root, '/admin').middleware(async (c, next) => {
      if (!c.req.header('authorization')) {
        return c.json({ error: 'UNAUTHORIZED' }, 401);
      }

      await next();
    });

    const publicRoute = defineChildContext(root, '/public');
    const secrets = defineChildContext(admin, '/secrets');

    const secretsRouter = leaf(secrets);

    expect(() => makeRouter(publicRoute, () => {}, [secretsRouter])()).toThrow(TypeError);
    expect(() => makeRouter(publicRoute, () => {}, [secretsRouter])()).toThrowError(
      "hono-typed-router: makeRouter: the child context '/api/admin/secrets' was defined under the context at '/api/admin', but its router is mounted under the context at '/api/public'.",
    );
  });

  it('mounts a value-form child under the parent it was defined from', async () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root, '/things');

    const app = makeRouter(root, () => {}, [leaf(things)])();

    expect((await app.request('/api/things')).status).toBe(200);
  });

  const pass: MiddlewareHandler = async (_c, next) => {
    await next();
  };

  it('accepts a child of root under root.middleware(a)', async () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root, '/things');

    const app = makeRouter(root.middleware(pass), () => {}, [leaf(things)])();

    expect((await app.request('/api/things')).status).toBe(200);
  });

  it('rejects a child of root.middleware(a) under root', () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root.middleware(pass), '/things');

    expect(() => makeRouter(root, () => {}, [leaf(things)])()).toThrowError(
      "hono-typed-router: makeRouter: the child context '/api/things' was defined under the context at '/api', but its router is mounted under an ancestor or an unrelated context with the same path '/api' (for example, the context before a .middleware() call, or a different root with the same path). Mount the router of a child under the router of the context that it was defined from, or of a .middleware() descendant of that context.",
    );
  });

  it('accepts a child of root.middleware(a) under root.middleware(a).middleware(b)', async () => {
    const root = defineRootContext('/api', []);
    const authed = root.middleware(pass);
    const things = defineChildContext(authed, '/things');

    const app = makeRouter(authed.middleware(pass), () => {}, [leaf(things)])();

    expect((await app.request('/api/things')).status).toBe(200);
  });

  it('rejects a child of root.middleware(a) under root.middleware(c), a sibling branch', () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root.middleware(pass), '/things');

    expect(() => makeRouter(root.middleware(pass), () => {}, [leaf(things)])()).toThrowError(
      /mounted under an ancestor or an unrelated context with the same path '\/api'/,
    );
  });

  it('rejects a child of root under a sibling value-form child of root', () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root, '/things');
    const other = defineChildContext(root, '/other');

    expect(() => makeRouter(other, () => {}, [leaf(things)])()).toThrowError(
      /mounted under the context at '\/api\/other'/,
    );
  });

  it('keeps the parent link through .middleware() on the child', async () => {
    const root = defineRootContext('/api', []);
    const other = defineRootContext('/other', []);

    const things = defineChildContext(root, '/things').middleware(async (_c, next) => {
      await next();
    });

    const app = makeRouter(root, () => {}, [leaf(things)])();
    expect((await app.request('/api/things')).status).toBe(200);

    expect(() => makeRouter(other, () => {}, [leaf(things)])()).toThrowError(
      /mounted under the context at '\/other'/,
    );
  });

  it('never checks curried children', async () => {
    const root = defineRootContext('/api', []);
    const other = defineRootContext('/other', []);
    const things = defineChildContext<typeof root>()('/things');

    expect(getRouteIdentity(things)?.parentId).toBeUndefined();

    const app = makeRouter(other, () => {}, [leaf(things)])();
    expect((await app.request('/other/things')).status).toBe(200);
  });

  it('does not check a thunk called directly', async () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root, '/things');

    expect((await leaf(things)().request('/things')).status).toBe(200);
  });

  it('carries the ids and the lineage through extendRouteContext builders and checks extended children', async () => {
    interface Ctx<P extends string, V extends object> extends RouteContextBase<CtxKind, P, V> {
      tag: () => ReaugmentContext<CtxKind, P, V>;
    }

    interface CtxKind extends RouteContextKind {
      type: Ctx<this['path'] & string, this['vars'] & object>;
    }

    const ext = extendRouteContext<CtxKind>({ tag: (ctx) => () => ctx.middleware(pass) });
    const root = ext.defineRootContext('/api');
    const other = ext.defineRootContext('/other');
    const things = ext.defineChildContext(root, '/things').tag();

    const derived = things.middleware(async (_c, next) => {
      await next();
    });

    const rootId = getRouteIdentity(root)?.id;
    expect(rootId).toBeTypeOf('symbol');
    expect(getRouteIdentity(things)).toMatchObject({ parentId: rootId, parentPath: '/api' });
    expect(getRouteIdentity(derived)?.parentId).toBe(rootId);
    expect(getRouteIdentity(derived)?.id).not.toBe(getRouteIdentity(things)?.id);
    // The identity key is a symbol, so it is not in the string keys.
    expect(Object.keys(things)).not.toContain('id');

    const app = makeRouter(root, () => {}, [leaf(things)])();
    expect((await app.request('/api/things')).status).toBe(200);

    expect(() => makeRouter(other, () => {}, [leaf(things)])()).toThrowError(
      /mounted under the context at '\/other'/,
    );

    const tagged = root.tag().middleware(pass);
    expect(getRouteIdentity(tagged)?.lineage).toContain(rootId);
    expect(getRouteIdentity(tagged)?.lineage).toHaveLength(3);

    const viaTagged = makeRouter(tagged, () => {}, [leaf(things)])();
    expect((await viaTagged.request('/api/things')).status).toBe(200);

    const childOfTagged = ext.defineChildContext(root.tag(), '/tagged');
    expect(() => makeRouter(root, () => {}, [leaf(childOfTagged)])()).toThrowError(
      /mounted under an ancestor or an unrelated context with the same path '\/api'/,
    );
  });
});

describe('mountRouter', () => {
  const makeRouter = createRouter();

  function leaf(ctx: Parameters<typeof makeRouter>[0]) {
    return makeRouter(ctx, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: c.get('hit' as never) === true }, 200),
      ),
    );
  }

  it('is a named function', () => {
    expect(mountRouter.name).toBe('mountRouter');
  });

  it('mounts the children at their full paths', async () => {
    const root = defineRootContext('/api', []);
    const things = defineChildContext(root, '/things');
    const stats = defineChildContext<typeof root>()('/stats');

    const app = mountRouter(root, [leaf(things), leaf(stats)]);

    expect((await app.request('/api/things')).status).toBe(200);
    expect((await app.request('/api/stats')).status).toBe(200);
    expect((await app.request('/api')).status).toBe(404);
  });

  it('runs the root context middlewares for the routes of the children', async () => {
    const root = defineRootContext('/api', []).middleware<{ hit: boolean }>(async (c, next) => {
      c.set('hit', true);
      await next();
    });

    const app = mountRouter(root, [leaf(defineChildContext(root, '/things'))]);

    expect(await (await app.request('/api/things')).json()).toEqual({ ok: true });
  });

  it('builds the same routes as the long makeRouter form', () => {
    const root = defineRootContext('/api', []);
    const things = leaf(defineChildContext(root, '/things'));

    const short = inspectRoutes(mountRouter(root, [things]));
    const long = inspectRoutes(makeRouter(root, ({ app }) => app, [things])());

    expect(short).toEqual(long);
  });

  it('throws through the mount guard for a value-form child mounted under another context', () => {
    const root = defineRootContext('/api', []);
    const admin = defineChildContext(root, '/admin');
    const publicRoute = defineRootContext('/public', []);
    const secrets = leaf(defineChildContext(admin, '/secrets'));

    expect(() => mountRouter(publicRoute, [secrets])).toThrowError(
      "hono-typed-router: mountRouter: the child context '/api/admin/secrets' was defined under the context at '/api/admin', but its router is mounted under the context at '/public'.",
    );
  });

  it('passes the full mounted path as meta.path to a curried grandchild', async () => {
    const seen: string[] = [];
    const root = defineRootContext('/api', []);
    const things = defineChildContext<typeof root>()('/things');
    const thing = defineChildContext<typeof things>()('/:id');

    const withHook = createRouter({
      routeMiddleware: (_route, meta) => {
        seen.push(meta.path);

        return async (_c, next) => {
          await next();
        };
      },
    });

    const thingRouter = withHook(thing, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

    const app = mountRouter(root, [withHook(things, () => {}, [thingRouter])]);

    expect(seen).toEqual(['/api/things/:id']);
    expect((await app.request('/api/things/1')).status).toBe(200);
  });

  it('shows the names of the context middlewares and the routeMiddleware in inspectRoutes', () => {
    const root = defineRootContext('/api', []).middleware(async function authenticate(_c, next) {
      await next();
    });

    const audited = createRouter({
      routeMiddleware: () =>
        async function auditLog(_c, next) {
          await next();
        },
    });

    const things = audited(defineChildContext(root, '/things'), ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

    const routes = inspectRoutes(mountRouter(root, [things]));

    expect(routes.find((r) => r.name === 'authenticate')).toMatchObject({ isMiddleware: true });
    expect(routes.find((r) => r.name === 'auditLog')).toMatchObject({
      method: 'GET',
      path: '/api/things',
    });
  });
});

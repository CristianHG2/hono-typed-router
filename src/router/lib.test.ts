import { inspectRoutes } from 'hono/dev';
import type { Context, MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  defineChildContext,
  defineChildRoute,
  defineRootContext,
  defineRootRoute,
  extendRouteContext,
} from '../definitions';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from '../definitions';
import { getRouteIdentity } from '../definitions/lib';
import { jsonRequest, jsonResponse } from '../factories';
import { createScopeMiddleware } from '../scopes';
import { createRouter } from './lib';
import { mountRouter } from './mount';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

describe('createRouter', () => {
  it('declares routes against a context base path', async () => {
    const ctx = defineRootContext('/api', []);
    const makeRouter = createRouter();

    const app = makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    const res = await app.request('/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('passes the same function as defineRoute and the deprecated route', async () => {
    const ctx = defineRootContext('/api', []);
    let same = false;

    const app = createRouter()(ctx, ({ app, defineRoute, route }) => {
      same = route === defineRoute;
      const r = route('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    expect(same).toBe(true);
    expect((await app.request('/api')).status).toBe(200);
  });

  it('applies context middlewares', async () => {
    const ctx = defineRootContext('/api', []).middleware<{ hit: boolean }>(async (c, next) => {
      c.set('hit', true);
      await next();
    });

    const app = createRouter()(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: c.get('hit' as never) === true }) as never);
    })();

    const res = await app.request('/api');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('runs routeMiddleware factories per route in array order', async () => {
    const calls: string[] = [];

    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: [
        (route) => async (_c, next) => {
          calls.push(`a:${route.method}`);
          await next();
        },
        (route) => async (_c, next) => {
          calls.push(`b:${route.method}`);
          await next();
        },
      ],
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    await app.request('/api');
    expect(calls).toEqual(['a:get', 'b:get']);
  });

  it('does not run routeMiddleware for a different method on the same path', async () => {
    let ran = false;
    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: () => async (_c, next) => {
        ran = true;
        await next();
      },
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('post', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    const res = await app.request('/api', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(ran).toBe(false);
  });

  it('runs routeMiddleware for HEAD requests on a GET route', async () => {
    let handlerRan = false;
    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: () => async (c) => c.json({ blocked: true }, 403),
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => {
        handlerRan = true;

        return c.json({ ok: true }) as never;
      });
    })();

    const res = await app.request('/api', { method: 'HEAD' });
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('runs routeMiddleware on routes whose path uses OpenAPI {param} syntax', async () => {
    let ran = false;
    const ctx = defineRootContext('/api', []);

    const metaPaths: string[] = [];

    const app = createRouter({
      transformRoute: (route, meta) => {
        metaPaths.push(`transform:${meta.path}`);

        return { ...route, path: '/users/{id}' };
      },
      routeMiddleware: (_route, meta) => {
        metaPaths.push(`factory:${meta.path}`);

        return async (_c, next) => {
          ran = true;
          await next();
        };
      },
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    const res = await app.request('/api/users/42');
    expect(res.status).toBe(200);
    expect(ran).toBe(true);
    // `meta.path` is computed before `transformRoute`, so the rewrite does not change it.
    expect(metaPaths).toEqual(['transform:/api', 'factory:/api']);
  });

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

    const build = (ctx: Parameters<typeof makeRouter>[0]) =>
      makeRouter(ctx, ({ defineRoute }) => {
        defineRoute('get', { responses: { 200: okResponse } });
      })();

    build(defineChildContext(root, '/things'));
    build(defineChildContext<typeof root>()('/things'));
    build(defineRootContext('', []));

    expect(seen).toEqual(['get / /api/things', 'get / /things', 'get / /']);
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

    // The same thunk called directly has no parent: meta.path is the curried segment.
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
      // `path` is not part of the typed input; a cast is the only way to declare `{param}` here.
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
  });

  it('runs context middlewares, then routeMiddleware in order, then validators, then the handler', async () => {
    const calls: string[] = [];

    const ctx = defineRootContext('/api', []).middleware(async (_c, next) => {
      calls.push('context');
      await next();
    });

    const app = createRouter({
      routeMiddleware: [
        () => async (_c, next) => {
          calls.push('route:a');
          await next();
        },
        () => async (_c, next) => {
          calls.push('route:b');
          await next();
        },
      ],
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', {
        request: {
          query: z.object({
            q: z.string().transform((v) => {
              calls.push('validator');

              return v;
            }),
          }),
        },
        responses: { 200: okResponse },
      });

      app.openapi(r as never, (c) => {
        calls.push('handler');

        return c.json({ ok: true }) as never;
      });
    })();

    const res = await app.request('/api?q=x');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['context', 'route:a', 'route:b', 'validator', 'handler']);
  });

  it('runs routeMiddleware before body validation, so a 403 beats a 400', async () => {
    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: () => async (c) => c.json({ error: 'forbidden' }, 403),
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('post', {
        request: jsonRequest(z.object({ name: z.string() }), 'Body'),
        responses: { 200: okResponse },
      });

      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    const res = await app.request('/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
  });

  it('shows a named routeMiddleware by name in inspectRoutes', () => {
    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: () =>
        async function auditLog(_c, next) {
          await next();
        },
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    const entry = inspectRoutes(app).find((r) => r.name === 'auditLog');
    expect(entry).toMatchObject({ method: 'GET', path: '/api' });
  });

  it('allows routeMiddleware to short-circuit with a response', async () => {
    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: () => async (c) => c.json({ blocked: true }, 401),
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    const res = await app.request('/api');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ blocked: true });
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

  // This test uses the deprecated names on purpose, so that the aliases stay covered until
  // 2.0. Do not change it to defineRootContext and defineChildContext.
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

  it('accepts a single routeMiddleware (not wrapped in array)', async () => {
    let ran = false;
    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: () => async (_c, next) => {
        ran = true;
        await next();
      },
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    await app.request('/api');
    expect(ran).toBe(true);
  });

  it('runs transformRoute before routeMiddleware factories and returns the transformed config', async () => {
    let factorySawTags: string[] | undefined;
    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      transformRoute: (route) => ({ ...route, tags: [...(route.tags ?? []), 'audited'] }),
      routeMiddleware: (route) => {
        factorySawTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    let returnedFromRoute: { tags?: readonly string[] } | undefined;
    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      returnedFromRoute = r as { tags?: readonly string[] };
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    expect(factorySawTags).toEqual(['audited']);
    expect(returnedFromRoute?.tags).toEqual(['audited']);
  });

  it('deep-merges routeDefaults into each declared route', async () => {
    const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
    let observed: { responses?: Record<string | number, unknown> } | undefined;

    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { responses: { 401: errResponse } },
      routeMiddleware: (route) => {
        observed = route as never;

        return async (_c, next) => {
          await next();
        };
      },
    });

    const app = makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    expect(Object.keys(observed?.responses ?? {}).sort()).toEqual(['200', '401']);
    const res = await app.request('/api');
    expect(res.status).toBe(200);
  });

  it('concatenates and dedupes arrays when merging routeDefaults', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { tags: ['common', 'shared'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse }, tags: ['shared', 'list'] });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    expect(observedTags).toEqual(['common', 'shared', 'list']);
  });

  it('lets per-route values win on overlapping leaf keys', async () => {
    const baseResp = jsonResponse(z.object({ from: z.literal('base') }), 'base');
    const routeResp = jsonResponse(z.object({ from: z.literal('route') }), 'route');
    let observed: { responses?: Record<string | number, { description?: string }> } | undefined;

    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { responses: { 200: baseResp } },
      routeMiddleware: (route) => {
        observed = route as never;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: routeResp } });
      app.openapi(r as never, (c) => c.json({ from: 'route' }) as never);
    })();

    expect(observed?.responses?.[200]?.description).toBe('route');
  });

  it('lets a route opt out of routeDefaults security with security: []', async () => {
    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { security: [{ bearer: ['things:read'] }] },
      routeMiddleware: createScopeMiddleware({ resolve: () => [] }),
    });

    const app = makeRouter(ctx, ({ app, defineRoute }) => {
      const open = defineRoute('get', { security: [], responses: { 200: okResponse } });
      const guarded = defineRoute('post', { responses: { 200: okResponse } });
      app.openapi(open, (c) => c.json({ ok: true }, 200));
      app.openapi(guarded, (c) => c.json({ ok: true }, 200));
    })();

    expect((await app.request('/api')).status).toBe(200);
    expect((await app.request('/api', { method: 'POST' })).status).toBe(403);

    const doc = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '1.0.0' },
    });

    expect(doc.paths?.['/api']?.get?.security).toEqual([]);
    expect(doc.paths?.['/api']?.post?.security).toEqual([{ bearer: ['things:read'] }]);
  });

  it('keeps an empty tags array additive when merging routeDefaults', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { tags: ['api'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { tags: [], responses: { 200: okResponse } });
      app.openapi(r, (c) => c.json({ ok: true }, 200));
    })();

    expect(observedTags).toEqual(['api']);
  });

  it('still accepts the deprecated base option', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      base: { tags: ['api'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { tags: ['things'], responses: { 200: okResponse } });
      app.openapi(r, (c) => c.json({ ok: true }, 200));
    })();

    expect(observedTags).toEqual(['api', 'things']);
  });

  it('prefers routeDefaults over base when both are set', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { tags: ['new'] },
      base: { tags: ['old'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    expect(observedTags).toEqual(['new']);
  });

  it('unions zod schemas when base and route define the same status', async () => {
    const baseSchema = z.object({ code: z.literal('BASE_INVALID') });
    const routeSchema = z.object({ code: z.literal('ROUTE_INVALID') });
    const baseResp = jsonResponse(baseSchema, 'Validation (base)');
    const routeResp = jsonResponse(routeSchema, 'Validation (route)');

    let observed:
      | {
          responses?: Record<string | number, { content?: Record<string, { schema?: z.ZodType }> }>;
        }
      | undefined;

    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { responses: { 422: baseResp } },
      routeMiddleware: (route) => {
        observed = route as never;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse, 422: routeResp } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    const mergedSchema = observed?.responses?.[422]?.content?.['application/json']?.schema;
    expect(mergedSchema).toBeDefined();
    expect(mergedSchema!.safeParse({ code: 'BASE_INVALID' }).success).toBe(true);
    expect(mergedSchema!.safeParse({ code: 'ROUTE_INVALID' }).success).toBe(true);
    expect(mergedSchema!.safeParse({ code: 'NEITHER' }).success).toBe(false);
  });

  it('applies the routeDefaults merge, then transformRoute', async () => {
    const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');

    let observed:
      | { responses?: Record<string | number, unknown>; tags?: readonly string[] }
      | undefined;

    const ctx = defineRootContext('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { responses: { 401: errResponse } },
      transformRoute: (route) => ({
        ...route,
        tags: [`has-${Object.keys(route.responses).length}-responses`],
      }),
      routeMiddleware: (route) => {
        observed = route as never;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    expect(observed?.tags).toEqual(['has-2-responses']);
    expect(Object.keys(observed?.responses ?? {}).sort()).toEqual(['200', '401']);
  });

  it('passes the resolved RouteConfig to the factory', async () => {
    let captured: { method?: string; path?: string } = {};
    const ctx = defineRootContext('/api', []);

    const app = createRouter({
      routeMiddleware: (route) => {
        captured = { method: route.method, path: route.path };

        return async (_c, next) => {
          await next();
        };
      },
    })(ctx, ({ app, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      app.openapi(r as never, (c) => c.json({ ok: true }) as never);
    })();

    await app.request('/api');
    expect(captured).toEqual({ method: 'get', path: '/' });
  });
});

describe('mount guard', () => {
  const makeRouter = createRouter();

  const leaf = (ctx: Parameters<typeof makeRouter>[0]) =>
    makeRouter(ctx, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

  it('throws when a value-form child is mounted under a different parent context', () => {
    const root = defineRootContext('/api', []);

    const admin = defineChildContext(root, '/admin').middleware(async (c, next) => {
      if (!c.req.header('authorization')) return c.json({ error: 'UNAUTHORIZED' }, 401);
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
    // The identity key is a symbol: it does not show in the context's string keys.
    expect(Object.keys(things)).not.toContain('id');

    const app = makeRouter(root, () => {}, [leaf(things)])();
    expect((await app.request('/api/things')).status).toBe(200);

    expect(() => makeRouter(other, () => {}, [leaf(things)])()).toThrowError(
      /mounted under the context at '\/other'/,
    );

    // Builders and `.middleware()` on an extended context extend the lineage.
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

  const leaf = (ctx: Parameters<typeof makeRouter>[0]) =>
    makeRouter(ctx, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: c.get('hit' as never) === true }, 200),
      ),
    );

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

describe('route middleware attaches at openapi', () => {
  const root = defineRootContext('/api', []);
  const things = defineChildContext(root, '/things');
  const other = defineChildContext(root, '/other');

  const named = (name: string): MiddlewareHandler => {
    const mw: MiddlewareHandler = async (_c, next) => {
      await next();
    };

    Object.defineProperty(mw, 'name', { value: name });

    return mw;
  };

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

    // No route declared: nothing to attach.
    // An app with an `any` schema passes the type check of the callback result.
    expect(makeRouter(things, () => new OpenAPIHono<any, any, any>())).not.toThrow();

    // Every factory returned `undefined`: the route has no middlewares.
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

describe('path params from the context path', () => {
  const root = defineRootContext('/api', []);
  const orgThings = defineChildContext(root, '/orgs/:orgId/things');
  const thingById = defineChildContext(orgThings, '/:id');
  const makeRouter = createRouter();

  const mountUnderOrgThings = (child: Parameters<typeof mountRouter>[1][number]) =>
    mountRouter(root, [makeRouter(orgThings, ({ app }) => app, [child])]);

  const doc = (app: { getOpenAPIDocument: (config: never) => unknown }) =>
    app.getOpenAPIDocument({ openapi: '3.0.0', info: { title: 't', version: '1' } } as never) as {
      paths: Record<string, Record<string, { parameters?: { in: string; name: string }[] }>>;
    };

  it('validates and documents the params of the full mounted path', async () => {
    const byId = makeRouter(thingById, ({ app, defineRoute }) =>
      app
        .openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json(
            { ok: c.req.valid('param').orgId === 'o1' && c.req.valid('param').id === 't1' },
            200,
          ),
        )
        .openapi(
          defineRoute('put', {
            request: { params: z.object({ id: z.coerce.number() }) },
            responses: { 200: okResponse },
          }),
          (c) => c.json({ ok: c.req.valid('param').id === 41 }, 200),
        ),
    );

    const app = mountRouter(root, [makeRouter(orgThings, ({ app }) => app, [byId])]);

    expect(await (await app.request('/api/orgs/o1/things/t1')).json()).toEqual({ ok: true });
    expect(await (await app.request('/api/orgs/o1/things/41', { method: 'PUT' })).json()).toEqual({
      ok: true,
    });
    expect((await app.request('/api/orgs/o1/things/abc', { method: 'PUT' })).status).toBe(400);

    const operations = doc(app).paths['/api/orgs/{orgId}/things/{id}'];

    const names = (method: string) =>
      operations?.[method]?.parameters?.map((p) => `${p.in}:${p.name}`).sort();

    expect(names('get')).toEqual(['path:id', 'path:orgId']);
    expect(names('put')).toEqual(['path:id', 'path:orgId']);
  });

  it('gives a mounted curried grandchild the params of every parent', async () => {
    const notes = defineChildContext<typeof thingById>()('/notes/:noteId');

    const notesRouter = makeRouter(notes, ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) => {
        const { orgId, id, noteId } = c.req.valid('param');

        return c.json({ ok: [orgId, id, noteId].join('/') === 'o/t/n' }, 200);
      }),
    );

    const app = mountRouter(root, [
      makeRouter(orgThings, ({ app }) => app, [
        makeRouter(thingById, ({ app }) => app, [notesRouter]),
      ]),
    ]);

    expect(await (await app.request('/api/orgs/o/things/t/notes/n')).json()).toEqual({ ok: true });

    // Called directly, the router serves at its segment and validates only its own param.
    const direct = notesRouter();
    expect(await (await direct.request('/notes/n')).json()).toEqual({ ok: false });
    expect((await direct.request('/notes/n')).status).toBe(200);
  });

  it('does not add an optional param', async () => {
    const files = defineChildContext(root, '/files/:name?');

    const app = mountRouter(root, [
      makeRouter(files, ({ app, defineRoute }) =>
        app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: c.req.param('name') === undefined }, 200),
        ),
      ),
    ]);

    expect(await (await app.request('/api/files')).json()).toEqual({ ok: true });
    expect(await (await app.request('/api/files/a')).json()).toEqual({ ok: false });

    // OpenAPI cannot show an optional path parameter, so the document lists none.
    const paths = doc(app).paths;
    const operations = Object.values(paths).flatMap((ops) => Object.values(ops));

    expect(Object.keys(paths)).toHaveLength(1);
    expect(operations.flatMap((op) => op.parameters ?? [])).toEqual([]);
  });

  it('adds the params of a sub-path in config.path', async () => {
    const app = mountUnderOrgThings(
      makeRouter(
        thingById,
        ({ app, defineRoute }) =>
          void app.openapi(
            // `MakeRouteFn` does not accept `path`; a cast sets it.
            defineRoute('get', {
              path: '/{sub}',
              responses: { 200: okResponse },
            } as never) as never,
            ((c: Context) =>
              c.json({ ok: JSON.stringify(c.req.valid('param' as never)) }, 200)) as never,
          ),
      ),
    );

    const res = await app.request('/api/orgs/o/things/t/s');

    expect(await res.json()).toEqual({ ok: JSON.stringify({ orgId: 'o', id: 't', sub: 's' }) });
    expect(Object.keys(doc(app).paths)).toEqual(['/api/orgs/{orgId}/things/{id}/{sub}']);
  });

  it('keeps the refinements of a declared params object', async () => {
    const app = mountUnderOrgThings(
      makeRouter(
        thingById,
        ({ app, defineRoute }) =>
          void app.openapi(
            defineRoute('get', {
              request: {
                params: z.object({ id: z.coerce.number() }).refine((v) => v.id > 0, 'positive'),
              },
              responses: { 200: okResponse },
            } as never) as never,
            ((c: Context) => {
              const { orgId, id } = c.req.valid('param' as never) as { orgId: string; id: number };

              return c.json({ ok: orgId === 'o' && id === 5 }, 200);
            }) as never,
          ),
      ),
    );

    expect(await (await app.request('/api/orgs/o/things/5')).json()).toEqual({ ok: true });
    expect((await app.request('/api/orgs/o/things/-1')).status).toBe(400);
  });

  it('reads the name of a param with a regex', async () => {
    const byNumber = defineChildContext(root, '/n/:id{[0-9]+}');

    const app = mountRouter(root, [
      makeRouter(byNumber, ({ app, defineRoute }) =>
        app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: c.req.valid('param').id === '12' }, 200),
        ),
      ),
    ]);

    expect(await (await app.request('/api/n/12')).json()).toEqual({ ok: true });
    expect((await app.request('/api/n/ab')).status).toBe(404);
  });

  it('keeps the config of a declared params object', async () => {
    const app = mountUnderOrgThings(
      makeRouter(
        thingById,
        ({ app, defineRoute }) =>
          void app.openapi(
            defineRoute('get', {
              request: { params: z.object({ id: z.string().min(3) }).strict() },
              responses: { 200: okResponse },
            }),
            (c) => c.json({ ok: true }, 200),
          ),
      ),
    );

    expect((await app.request('/api/orgs/o/things/abc')).status).toBe(200);
    expect((await app.request('/api/orgs/o/things/ab')).status).toBe(400);
  });

  it('adds the missing path params to routeDefaults.request.params', async () => {
    const complete = createRouter({
      routeDefaults: { request: { params: z.object({ orgId: z.string(), id: z.string() }) } },
    });

    const partial = createRouter({
      routeDefaults: { request: { params: z.object({ v: z.string().optional() }) } },
    });

    const results = [complete, partial].map(async (withDefaults) => {
      const app = mountUnderOrgThings(
        withDefaults(thingById, ({ app, defineRoute }) =>
          app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) => {
            const { orgId, id } = c.req.valid('param');

            return c.json({ ok: orgId === 'o' && id === 't' }, 200);
          }),
        ),
      );

      const body: unknown = await (await app.request('/api/orgs/o/things/t')).json();

      const names = doc(app)
        .paths['/api/orgs/{orgId}/things/{id}']?.get?.parameters?.filter((p) => p.in === 'path')
        .map((p) => p.name);

      return { body, names };
    });

    for (const { body, names } of await Promise.all(results)) {
      expect(body).toEqual({ ok: true });

      // `v` is a key of the default params, so the document also lists it.
      expect(names).toEqual(expect.arrayContaining(['id', 'orgId']));
    }
  });
});

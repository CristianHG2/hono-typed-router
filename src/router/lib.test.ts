import { inspectRoutes } from 'hono/dev';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRootRoute, defineChildRoute, extendRouteContext } from '../definitions';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from '../definitions';
import { getRouteIdentity } from '../definitions/lib';
import { jsonRequest, jsonResponse } from '../factories';
import { createScopeMiddleware } from '../scopes';
import { createRouter } from './lib';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

describe('createRouter', () => {
  it('declares routes against a context base path', async () => {
    const ctx = defineRootRoute('/api', []);
    const makeRouter = createRouter();

    const router = makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    const res = await router.request('/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('passes the same function as defineRoute and the deprecated route', async () => {
    const ctx = defineRootRoute('/api', []);
    let same = false;

    const router = createRouter()(ctx, ({ router, defineRoute, route }) => {
      same = route === defineRoute;
      const r = route('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    expect(same).toBe(true);
    expect((await router.request('/api')).status).toBe(200);
  });

  it('applies context middlewares', async () => {
    const ctx = defineRootRoute('/api', []).middleware<{ hit: boolean }>(async (c, next) => {
      c.set('hit', true);
      await next();
    });

    const router = createRouter()(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: c.get('hit' as never) === true }) as never);

      return router;
    })();

    const res = await router.request('/api');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('runs routeMiddleware factories per route in array order', async () => {
    const calls: string[] = [];

    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
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
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    await router.request('/api');
    expect(calls).toEqual(['a:get', 'b:get']);
  });

  it('does not run routeMiddleware for a different method on the same path', async () => {
    let ran = false;
    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
      routeMiddleware: () => async (_c, next) => {
        ran = true;
        await next();
      },
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('post', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    const res = await router.request('/api', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(ran).toBe(false);
  });

  it('runs routeMiddleware for HEAD requests on a GET route', async () => {
    let handlerRan = false;
    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
      routeMiddleware: () => async (c) => c.json({ blocked: true }, 403),
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => {
        handlerRan = true;

        return c.json({ ok: true }) as never;
      });

      return router;
    })();

    const res = await router.request('/api', { method: 'HEAD' });
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('runs routeMiddleware on routes whose path uses OpenAPI {param} syntax', async () => {
    let ran = false;
    const ctx = defineRootRoute('/api', []);

    const metaPaths: string[] = [];

    const router = createRouter({
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
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    const res = await router.request('/api/users/42');
    expect(res.status).toBe(200);
    expect(ran).toBe(true);
    // `meta.path` is computed before `transformRoute`, so the rewrite does not change it.
    expect(metaPaths).toEqual(['transform:/api', 'factory:/api']);
  });

  it('passes meta.path from a directly called thunk: the full path for a value-form child, the segment for a curried one', () => {
    const seen: string[] = [];
    const root = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      routeMiddleware: (route, meta) => {
        seen.push(`${route.method} ${route.path} ${meta.path}`);

        return async (_c, next) => {
          await next();
        };
      },
    });

    const build = (ctx: Parameters<typeof makeRouter>[0]) =>
      makeRouter(ctx, ({ router, defineRoute }) => {
        defineRoute('get', { responses: { 200: okResponse } });

        return router;
      })();

    build(defineChildRoute(root, '/things'));
    build(defineChildRoute<typeof root>()('/things'));
    build(defineRootRoute('', []));

    expect(seen).toEqual(['get / /api/things', 'get / /things', 'get / /']);
  });

  it('passes the full mounted path as meta.path for curried children and grandchildren', async () => {
    const seen: string[] = [];
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute<typeof root>()('/things');
    const thing = defineChildRoute<typeof things>()('/:id');

    const makeRouter = createRouter({
      routeMiddleware: (_route, meta) => {
        seen.push(meta.path);

        return async (_c, next) => {
          await next();
        };
      },
    });

    const thingRouter = makeRouter(thing, ({ router, defineRoute }) =>
      router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

    const thingsRouter = makeRouter(
      things,
      ({ router, defineRoute }) =>
        router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
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
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute<typeof root>()('/things');

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

    const thingsRouter = makeRouter(things, ({ router, defineRoute }) => {
      defineRoute('get', { responses: { 200: okResponse } });
      defineRoute('post', { path: '/{id}', responses: { 200: okResponse } } as never);

      return router;
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

    makeRouter(defineChildRoute(defineRootRoute('/', []), '/things'), ({ router, defineRoute }) => {
      // `path` is not part of the typed input; a cast is the only way to declare `{param}` here.
      defineRoute('get', { path: '/{id}', responses: { 200: okResponse } } as never);

      return router;
    })();
    makeRouter(defineRootRoute('/', []), ({ router, defineRoute }) => {
      defineRoute('get', { path: '/x', responses: { 200: okResponse } } as never);

      return router;
    })();

    expect(seen).toEqual(['/things/:id', '/x']);
  });

  it('joins a value-form child of a root `/` without a double slash and mounts it once', async () => {
    const root = defineRootRoute('/', []);
    const things = defineChildRoute(root, '/things');
    expect(things.path).toBe('/things');
    expect(defineChildRoute(things, '/:id').path).toBe('/things/:id');
    expect(defineChildRoute(defineRootRoute('', []), '/things').path).toBe('/things');
    expect(defineChildRoute(defineRootRoute('/api/', []), '/x').path).toBe('/api/x');

    const makeRouter = createRouter();

    const thingsRouter = makeRouter(things, ({ router, defineRoute }) => {
      const list = defineRoute('get', { responses: { 200: okResponse } });
      expect(list.path).toBe('/');
      router.openapi(list, (c) => c.json({ ok: true }, 200));

      return router;
    });

    const app = makeRouter(root, () => {}, [thingsRouter])();

    expect((await app.request('/things')).status).toBe(200);

    const paths = inspectRoutes(app)
      .filter((r) => !r.isMiddleware)
      .map((r) => r.path);

    expect(paths).toEqual(['/things']);
  });

  it('joins a child segment without a leading `/` with one and serves it where meta.path says', async () => {
    const root = defineRootRoute('/api', []);
    const x = defineChildRoute(root, 'x');
    expect(x.path).toBe('/api/x');
    expect(defineChildRoute(x, 'y').path).toBe('/api/x/y');
    expect(defineChildRoute(defineRootRoute('', []), 'x').path).toBe('/x');
    expect(defineChildRoute(root, '').path).toBe('/api');

    const seen: string[] = [];

    const makeRouter = createRouter({
      routeMiddleware: [
        (_route, meta) => async (_c, next) => {
          seen.push(meta.path);
          await next();
        },
      ],
    });

    const xRouter = makeRouter(x, ({ router, defineRoute }) =>
      router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
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

    const ctx = defineRootRoute('/api', []).middleware(async (_c, next) => {
      calls.push('context');
      await next();
    });

    const router = createRouter({
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
    })(ctx, ({ router, defineRoute }) => {
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

      router.openapi(r as never, (c) => {
        calls.push('handler');

        return c.json({ ok: true }) as never;
      });

      return router;
    })();

    const res = await router.request('/api?q=x');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['context', 'route:a', 'route:b', 'validator', 'handler']);
  });

  it('runs routeMiddleware before body validation, so a 403 beats a 400', async () => {
    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
      routeMiddleware: () => async (c) => c.json({ error: 'forbidden' }, 403),
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('post', {
        request: jsonRequest(z.object({ name: z.string() }), 'Body'),
        responses: { 200: okResponse },
      });

      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    const res = await router.request('/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
  });

  it('shows a named routeMiddleware by name in inspectRoutes', () => {
    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
      routeMiddleware: () =>
        async function auditLog(_c, next) {
          await next();
        },
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    const entry = inspectRoutes(router).find((r) => r.name === 'auditLog');
    expect(entry).toMatchObject({ method: 'GET', path: '/api' });
  });

  it('allows routeMiddleware to short-circuit with a response', async () => {
    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
      routeMiddleware: () => async (c) => c.json({ blocked: true }, 401),
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    const res = await router.request('/api');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ blocked: true });
  });

  it('composes child routers', async () => {
    const parent = defineRootRoute('/api', []);
    const child = defineChildRoute<typeof parent>()('/things');
    const makeRouter = createRouter();

    const childRouter = makeRouter(child, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    });

    const root = makeRouter(parent, ({ router }) => router, [childRouter])();

    const res = await root.request('/api/things');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('mounts children when the parent factory forgets to return the router', async () => {
    const parent = defineRootRoute('/api', []);
    const child = defineChildRoute<typeof parent>()('/things');
    const makeRouter = createRouter();

    const childRouter = makeRouter(child, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    });

    const root = makeRouter(parent, () => {}, [childRouter])();

    const res = await root.request('/api/things');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('mounts three levels of value-form children at single-prefixed URLs', async () => {
    const root = defineRootRoute('/api', []).middleware<{ user: string }>(async (c, next) => {
      c.set('user', 'u1');
      await next();
    });

    const orgs = defineChildRoute(root, '/orgs');

    const org = defineChildRoute(orgs, '/:orgId').middleware<{ orgId: string }>(async (c, next) => {
      c.set('orgId', c.req.param('orgId'));
      await next();
    });

    const members = defineChildRoute(org, '/members');
    const makeRouter = createRouter();

    expect(members.path).toBe('/api/orgs/:orgId/members');

    const membersRouter = makeRouter(members, ({ router, defineRoute }) => {
      const list = defineRoute('get', {
        responses: {
          200: jsonResponse(z.object({ user: z.string(), orgId: z.string() }), 'OK'),
        },
      });

      router.openapi(list, (c) => c.json({ user: c.var.user, orgId: c.var.orgId }, 200));

      return router;
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
    const root = ext.defineRootRoute('/api');
    const things = ext.defineChildRoute(root, '/things').tag();
    const makeRouter = createRouter();

    expect(things.path).toBe('/api/things');

    const thingsRouter = makeRouter(things, ({ router, defineRoute }) => {
      router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      );

      return router;
    });

    const app = makeRouter(root, () => {}, [thingsRouter])();
    expect((await app.request('/api/things')).status).toBe(200);
  });

  it('accepts a single routeMiddleware (not wrapped in array)', async () => {
    let ran = false;
    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
      routeMiddleware: () => async (_c, next) => {
        ran = true;
        await next();
      },
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    await router.request('/api');
    expect(ran).toBe(true);
  });

  it('runs transformRoute before routeMiddleware factories and returns the transformed config', async () => {
    let factorySawTags: string[] | undefined;
    const ctx = defineRootRoute('/api', []);

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
    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      returnedFromRoute = r as { tags?: readonly string[] };
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    expect(factorySawTags).toEqual(['audited']);
    expect(returnedFromRoute?.tags).toEqual(['audited']);
  });

  it('deep-merges routeDefaults into each declared route', async () => {
    const errResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');
    let observed: { responses?: Record<string | number, unknown> } | undefined;

    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { responses: { 401: errResponse } },
      routeMiddleware: (route) => {
        observed = route as never;

        return async (_c, next) => {
          await next();
        };
      },
    });

    const router = makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    expect(Object.keys(observed?.responses ?? {}).sort()).toEqual(['200', '401']);
    const res = await router.request('/api');
    expect(res.status).toBe(200);
  });

  it('concatenates and dedupes arrays when merging routeDefaults', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { tags: ['common', 'shared'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse }, tags: ['shared', 'list'] });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    expect(observedTags).toEqual(['common', 'shared', 'list']);
  });

  it('lets per-route values win on overlapping leaf keys', async () => {
    const baseResp = jsonResponse(z.object({ from: z.literal('base') }), 'base');
    const routeResp = jsonResponse(z.object({ from: z.literal('route') }), 'route');
    let observed: { responses?: Record<string | number, { description?: string }> } | undefined;

    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { responses: { 200: baseResp } },
      routeMiddleware: (route) => {
        observed = route as never;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: routeResp } });
      router.openapi(r as never, (c) => c.json({ from: 'route' }) as never);

      return router;
    })();

    expect(observed?.responses?.[200]?.description).toBe('route');
  });

  it('lets a route opt out of routeDefaults security with security: []', async () => {
    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { security: [{ bearer: ['things:read'] }] },
      routeMiddleware: createScopeMiddleware({ resolve: () => [] }),
    });

    const app = makeRouter(ctx, ({ router, defineRoute }) => {
      const open = defineRoute('get', { security: [], responses: { 200: okResponse } });
      const guarded = defineRoute('post', { responses: { 200: okResponse } });
      router.openapi(open, (c) => c.json({ ok: true }, 200));
      router.openapi(guarded, (c) => c.json({ ok: true }, 200));

      return router;
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
    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { tags: ['api'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { tags: [], responses: { 200: okResponse } });
      router.openapi(r, (c) => c.json({ ok: true }, 200));

      return router;
    })();

    expect(observedTags).toEqual(['api']);
  });

  it('still accepts the deprecated base option', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      base: { tags: ['api'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { tags: ['things'], responses: { 200: okResponse } });
      router.openapi(r, (c) => c.json({ ok: true }, 200));

      return router;
    })();

    expect(observedTags).toEqual(['api', 'things']);
  });

  it('prefers routeDefaults over base when both are set', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootRoute('/api', []);

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

    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
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

    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      routeDefaults: { responses: { 422: baseResp } },
      routeMiddleware: (route) => {
        observed = route as never;

        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse, 422: routeResp } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
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

    const ctx = defineRootRoute('/api', []);

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

    makeRouter(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    expect(observed?.tags).toEqual(['has-2-responses']);
    expect(Object.keys(observed?.responses ?? {}).sort()).toEqual(['200', '401']);
  });

  it('passes the resolved RouteConfig to the factory', async () => {
    let captured: { method?: string; path?: string } = {};
    const ctx = defineRootRoute('/api', []);

    const router = createRouter({
      routeMiddleware: (route) => {
        captured = { method: route.method, path: route.path };

        return async (_c, next) => {
          await next();
        };
      },
    })(ctx, ({ router, defineRoute }) => {
      const r = defineRoute('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);

      return router;
    })();

    await router.request('/api');
    expect(captured).toEqual({ method: 'get', path: '/' });
  });
});

describe('mount guard', () => {
  const makeRouter = createRouter();

  const leaf = (ctx: Parameters<typeof makeRouter>[0]) =>
    makeRouter(ctx, ({ router, defineRoute }) =>
      router.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    );

  it('throws when a value-form child is mounted under a different parent context', () => {
    const root = defineRootRoute('/api', []);

    const admin = defineChildRoute(root, '/admin').middleware(async (c, next) => {
      if (!c.req.header('authorization')) return c.json({ error: 'UNAUTHORIZED' }, 401);
      await next();
    });

    const publicRoute = defineChildRoute(root, '/public');
    const secrets = defineChildRoute(admin, '/secrets');

    const secretsRouter = leaf(secrets);

    expect(() => makeRouter(publicRoute, () => {}, [secretsRouter])()).toThrowError(
      "makeRouter: the child context '/api/admin/secrets' was defined under the context at '/api/admin', but its router is mounted under the context at '/api/public'.",
    );
  });

  it('mounts a value-form child under the parent it was defined from', async () => {
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute(root, '/things');

    const app = makeRouter(root, () => {}, [leaf(things)])();

    expect((await app.request('/api/things')).status).toBe(200);
  });

  const pass: MiddlewareHandler = async (_c, next) => {
    await next();
  };

  it('accepts a child of root under root.middleware(a)', async () => {
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute(root, '/things');

    const app = makeRouter(root.middleware(pass), () => {}, [leaf(things)])();

    expect((await app.request('/api/things')).status).toBe(200);
  });

  it('rejects a child of root.middleware(a) under root', () => {
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute(root.middleware(pass), '/things');

    expect(() => makeRouter(root, () => {}, [leaf(things)])()).toThrowError(
      "makeRouter: the child context '/api/things' was defined under the context at '/api', but its router is mounted under an ancestor or an unrelated context with the same path '/api' (for example, the context before a .middleware() call, or a different root with the same path). Mount the router of a child under the router of the context that it was defined from, or of a .middleware() descendant of that context.",
    );
  });

  it('accepts a child of root.middleware(a) under root.middleware(a).middleware(b)', async () => {
    const root = defineRootRoute('/api', []);
    const authed = root.middleware(pass);
    const things = defineChildRoute(authed, '/things');

    const app = makeRouter(authed.middleware(pass), () => {}, [leaf(things)])();

    expect((await app.request('/api/things')).status).toBe(200);
  });

  it('rejects a child of root.middleware(a) under root.middleware(c), a sibling branch', () => {
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute(root.middleware(pass), '/things');

    expect(() => makeRouter(root.middleware(pass), () => {}, [leaf(things)])()).toThrowError(
      /mounted under an ancestor or an unrelated context with the same path '\/api'/,
    );
  });

  it('rejects a child of root under a sibling value-form child of root', () => {
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute(root, '/things');
    const other = defineChildRoute(root, '/other');

    expect(() => makeRouter(other, () => {}, [leaf(things)])()).toThrowError(
      /mounted under the context at '\/api\/other'/,
    );
  });

  it('keeps the parent link through .middleware() on the child', async () => {
    const root = defineRootRoute('/api', []);
    const other = defineRootRoute('/other', []);

    const things = defineChildRoute(root, '/things').middleware(async (_c, next) => {
      await next();
    });

    const app = makeRouter(root, () => {}, [leaf(things)])();
    expect((await app.request('/api/things')).status).toBe(200);

    expect(() => makeRouter(other, () => {}, [leaf(things)])()).toThrowError(
      /mounted under the context at '\/other'/,
    );
  });

  it('never checks curried children', async () => {
    const root = defineRootRoute('/api', []);
    const other = defineRootRoute('/other', []);
    const things = defineChildRoute<typeof root>()('/things');

    expect(getRouteIdentity(things)?.parentId).toBeUndefined();

    const app = makeRouter(other, () => {}, [leaf(things)])();
    expect((await app.request('/other/things')).status).toBe(200);
  });

  it('does not check a thunk called directly', async () => {
    const root = defineRootRoute('/api', []);
    const things = defineChildRoute(root, '/things');

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
    const root = ext.defineRootRoute('/api');
    const other = ext.defineRootRoute('/other');
    const things = ext.defineChildRoute(root, '/things').tag();

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

    const childOfTagged = ext.defineChildRoute(root.tag(), '/tagged');
    expect(() => makeRouter(root, () => {}, [leaf(childOfTagged)])()).toThrowError(
      /mounted under an ancestor or an unrelated context with the same path '\/api'/,
    );
  });
});

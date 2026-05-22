import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRootRoute, defineChildRoute } from '../definitions';
import { makeHonoResponse } from '../factories';
import { createRouter } from './lib';

const okResponse = makeHonoResponse(z.object({ ok: z.boolean() }), 'OK');

describe('createRouter', () => {
  it('declares routes against a context base path', async () => {
    const ctx = defineRootRoute('/api', []);
    const makeRouter = createRouter();

    const router = makeRouter(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    })();

    const res = await router.request('/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('applies context middlewares', async () => {
    const ctx = defineRootRoute('/api', []).middleware<{ hit: boolean }>(async (c, next) => {
      c.set('hit', true);
      await next();
    });

    const router = createRouter()(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
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
    })(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
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
    })(ctx, ({ router, route }) => {
      const r = route('post', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    })();

    const res = await router.request('/api', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(ran).toBe(false);
  });

  it('allows routeMiddleware to short-circuit with a response', async () => {
    const ctx = defineRootRoute('/api', []);
    const router = createRouter({
      routeMiddleware: () => async (c) => c.json({ blocked: true }, 401),
    })(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
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

    const childRouter = makeRouter(child, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    });

    const root = makeRouter(parent, ({ router }) => router, [childRouter])();

    const res = await root.request('/api/things');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('accepts a single routeMiddleware (not wrapped in array)', async () => {
    let ran = false;
    const ctx = defineRootRoute('/api', []);
    const router = createRouter({
      routeMiddleware: () => async (_c, next) => {
        ran = true;
        await next();
      },
    })(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
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
    makeRouter(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
      returnedFromRoute = r as { tags?: readonly string[] };
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    })();

    expect(factorySawTags).toEqual(['audited']);
    expect(returnedFromRoute?.tags).toEqual(['audited']);
  });

  it('deep-merges base RouteConfig into each declared route', async () => {
    const errResponse = makeHonoResponse(z.object({ error: z.string() }), 'Unauthorized');
    let observed: { responses?: Record<string | number, unknown> } | undefined;

    const ctx = defineRootRoute('/api', []);
    const makeRouter = createRouter({
      base: { responses: { 401: errResponse } },
      routeMiddleware: (route) => {
        observed = route as never;
        return async (_c, next) => {
          await next();
        };
      },
    });

    const router = makeRouter(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    })();

    expect(Object.keys(observed?.responses ?? {}).sort()).toEqual(['200', '401']);
    const res = await router.request('/api');
    expect(res.status).toBe(200);
  });

  it('concatenates and dedupes arrays when merging base', async () => {
    let observedTags: readonly string[] | undefined;
    const ctx = defineRootRoute('/api', []);

    const makeRouter = createRouter({
      base: { tags: ['common', 'shared'] },
      routeMiddleware: (route) => {
        observedTags = route.tags;
        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse }, tags: ['shared', 'list'] });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    })();

    expect(observedTags).toEqual(['common', 'shared', 'list']);
  });

  it('lets per-route values win on overlapping leaf keys', async () => {
    const baseResp = makeHonoResponse(z.object({ from: z.literal('base') }), 'base');
    const routeResp = makeHonoResponse(z.object({ from: z.literal('route') }), 'route');
    let observed: { responses?: Record<string | number, { description?: string }> } | undefined;

    const ctx = defineRootRoute('/api', []);
    const makeRouter = createRouter({
      base: { responses: { 200: baseResp } },
      routeMiddleware: (route) => {
        observed = route as never;
        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: routeResp } });
      router.openapi(r as never, (c) => c.json({ from: 'route' }) as never);
      return router;
    })();

    expect(observed?.responses?.[200]?.description).toBe('route');
  });

  it('unions zod schemas when base and route define the same status', async () => {
    const baseSchema = z.object({ code: z.literal('BASE_INVALID') });
    const routeSchema = z.object({ code: z.literal('ROUTE_INVALID') });
    const baseResp = makeHonoResponse(baseSchema, 'Validation (base)');
    const routeResp = makeHonoResponse(routeSchema, 'Validation (route)');

    let observed: {
      responses?: Record<string | number, { content?: Record<string, { schema?: z.ZodType }> }>;
    } | undefined;

    const ctx = defineRootRoute('/api', []);
    const makeRouter = createRouter({
      base: { responses: { 422: baseResp } },
      routeMiddleware: (route) => {
        observed = route as never;
        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse, 422: routeResp } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    })();

    const mergedSchema = observed?.responses?.[422]?.content?.['application/json']?.schema;
    expect(mergedSchema).toBeDefined();
    expect(mergedSchema!.safeParse({ code: 'BASE_INVALID' }).success).toBe(true);
    expect(mergedSchema!.safeParse({ code: 'ROUTE_INVALID' }).success).toBe(true);
    expect(mergedSchema!.safeParse({ code: 'NEITHER' }).success).toBe(false);
  });

  it('applies base merge then transformRoute', async () => {
    const errResponse = makeHonoResponse(z.object({ error: z.string() }), 'Unauthorized');
    let observed: { responses?: Record<string | number, unknown>; tags?: readonly string[] } | undefined;

    const ctx = defineRootRoute('/api', []);
    const makeRouter = createRouter({
      base: { responses: { 401: errResponse } },
      transformRoute: (route) => ({ ...route, tags: [`has-${Object.keys(route.responses).length}-responses`] }),
      routeMiddleware: (route) => {
        observed = route as never;
        return async (_c, next) => {
          await next();
        };
      },
    });

    makeRouter(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
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
    })(ctx, ({ router, route }) => {
      const r = route('get', { responses: { 200: okResponse } });
      router.openapi(r as never, (c) => c.json({ ok: true }) as never);
      return router;
    })();

    await router.request('/api');
    expect(captured).toEqual({ method: 'get', path: '/' });
  });
});

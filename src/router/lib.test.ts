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

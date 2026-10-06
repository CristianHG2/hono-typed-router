import { inspectRoutes } from 'hono/dev';
import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { defineRootContext } from '../definitions';
import { jsonRequest, jsonResponse } from '../schema-helpers';
import { createScopeMiddleware } from '../scopes';
import { createRouter } from './create-router';

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

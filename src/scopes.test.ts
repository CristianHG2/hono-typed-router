import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRootRoute } from './definitions';
import { makeHonoResponse } from './factories';
import { createRouter } from './router';
import { createScopeMiddleware } from './scopes';

const okResponse = makeHonoResponse(z.object({ ok: z.boolean() }), 'OK');

const buildApp = (
  available: readonly string[],
  security: { oauth2: string[] }[] | undefined,
  onForbidden?: (missing: string[]) => unknown,
) => {
  const ctx = defineRootRoute('/api', []);
  const makeRouter = createRouter({
    routeMiddleware: createScopeMiddleware({
      resolve: () => available,
      onForbidden,
    }),
  });

  return makeRouter(ctx, ({ router, route }) => {
    const r = route('get', { security, responses: { 200: okResponse } });
    router.openapi(r as never, (c) => c.json({ ok: true }) as never);
    return router;
  })();
};

describe('createScopeMiddleware', () => {
  it('passes the request through when all required scopes are present', async () => {
    const app = buildApp(['read:things', 'write:things'], [{ oauth2: ['read:things'] }]);
    const res = await app.request('/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 403 with the default body when a required scope is missing', async () => {
    const app = buildApp(['read:things'], [{ oauth2: ['write:things'] }]);
    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'E_FORBIDDEN',
      message: 'Missing write:things scope(s)',
    });
  });

  it('honors a custom onForbidden body', async () => {
    const app = buildApp(
      [],
      [{ oauth2: ['admin'] }],
      (missing) => ({ code: 'NOPE', need: missing }),
    );
    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'NOPE', need: ['admin'] });
  });

  it('is a no-op for routes without security', async () => {
    const app = buildApp([], undefined);
    const res = await app.request('/api');
    expect(res.status).toBe(200);
  });

  it('deduplicates required scopes across security entries', async () => {
    const app = buildApp(
      ['a'],
      [{ oauth2: ['a', 'b'] }, { oauth2: ['b', 'c'] }],
    );
    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'E_FORBIDDEN',
      message: 'Missing b, c scope(s)',
    });
  });
});

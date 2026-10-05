import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRootContext } from './definitions';
import { jsonResponse } from './factories';
import { createRouter } from './router';
import { createScopeMiddleware } from './scopes';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const buildApp = (
  available: readonly string[],
  security: { oauth2: string[] }[] | undefined,
  onForbidden?: (missing: string[]) => unknown,
) => {
  const ctx = defineRootContext('/api', []);

  const makeRouter = createRouter({
    routeMiddleware: createScopeMiddleware({
      resolve: () => available,
      onForbidden,
    }),
  });

  return makeRouter(ctx, ({ router, defineRoute }) => {
    const r = defineRoute('get', { security, responses: { 200: okResponse } });
    router.openapi(r as never, (c) => c.json({ ok: true }) as never);
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
    const app = buildApp([], [{ oauth2: ['admin'] }], (missing) => ({
      code: 'NOPE',
      need: missing,
    }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'NOPE', need: ['admin'] });
  });

  it('registers no middleware for routes without scopes', async () => {
    const app = buildApp([], undefined);
    const res = await app.request('/api');
    expect(res.status).toBe(200);

    const factory = createScopeMiddleware({ resolve: () => [] });
    const meta = { path: '/' };

    const route = (security?: Record<string, string[]>[]) =>
      ({ method: 'get', path: '/', responses: {}, security }) as never;

    expect(factory(route(), meta)).toBeUndefined();
    expect(factory(route([]), meta)).toBeUndefined();
    expect(factory(route([{ bearer: [] }]), meta)).toBeUndefined();
    expect(factory(route([{ bearer: ['a'] }]), meta)).toBeTypeOf('function');
  });

  it('deduplicates required scopes across security entries', async () => {
    const app = buildApp(['a'], [{ oauth2: ['a', 'b'] }, { oauth2: ['b', 'c'] }]);
    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'E_FORBIDDEN',
      message: 'Missing b, c scope(s)',
    });
  });

  it('names the middleware after the required scopes', () => {
    const factory = createScopeMiddleware({ resolve: () => [] });

    const route = (security?: { oauth2: string[] }[]) =>
      ({ method: 'get', path: '/', responses: {}, security }) as never;

    const meta = { path: '/' };

    expect(factory(route([{ oauth2: ['things.read', 'things.write'] }]), meta)?.name).toBe(
      'requireScopes:things.read+things.write',
    );
    expect(factory(route([{ oauth2: ['has space', 'f(x)'] }]), meta)?.name).toBe(
      'requireScopes:has_space+f_x_',
    );
  });

  it('types `c.var` in `resolve` and `onForbidden` from a type argument or a context', async () => {
    type Session = { userId: string; scopes: string[] };

    const root = defineRootContext('/api').middleware<{ session: Session }>(async (c, next) => {
      c.set('session', { userId: 'u1', scopes: ['read'] });
      await next();
    });

    const fromTypeArgument = createScopeMiddleware<{ session: Session }>({
      resolve: (c) => {
        expectTypeOf(c.var.session).toEqualTypeOf<Session>();

        return c.var.session.scopes;
      },
      onForbidden: (missing, c) => ({ user: c.var.session.userId, missing }),
    });

    const fromContext = createScopeMiddleware(root, {
      resolve: (c) => {
        expectTypeOf(c.var.session).toEqualTypeOf<Session>();

        return c.var.session.scopes;
      },
      onForbidden: (missing, c) => ({ user: c.var.session.userId, missing }),
    });

    createScopeMiddleware(root, {
      // @ts-expect-error Property 'sesion' does not exist. Did you mean 'session'?
      resolve: (c) => c.var.sesion.scopes,
    });

    // @ts-expect-error without a type argument or a context, `c.var` has no vars
    createScopeMiddleware({ resolve: (c) => c.var.session.scopes });

    const responses = await Promise.all(
      [fromTypeArgument, fromContext].map((routeMiddleware) => {
        const app = createRouter({ routeMiddleware })(root, ({ router, defineRoute }) => {
          const r = defineRoute('get', {
            security: [{ bearer: ['write'] }],
            responses: { 200: okResponse },
          });

          router.openapi(r as never, (c) => c.json({ ok: true }) as never);
        })();

        return app.request('/api');
      }),
    );

    for (const res of responses) expect(res.status).toBe(403);

    const bodies = await Promise.all(responses.map((res) => res.json()));
    expect(bodies).toEqual([
      { user: 'u1', missing: ['write'] },
      { user: 'u1', missing: ['write'] },
    ]);
  });
});

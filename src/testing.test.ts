import { expectTypeOf } from 'expect-type';
import { testClient } from 'hono/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineChildContext, defineRootContext } from './definitions';
import { onError } from './errors';
import { jsonRequest, jsonResponse } from './factories';
import { handle } from './handler';
import { createRouter, mountRouter } from './router';
import { createScopeMiddleware } from './scopes';

class ThingNotFound extends Error {}

const Thing = z.object({ id: z.string(), name: z.string() });

const Message = z.object({ message: z.string() });

const Forbidden = z.object({ error: z.string(), message: z.string() });

type Session = { userId: string; scopes: string[] };

function buildApp() {
  const root = defineRootContext('/api', []).middleware<{ session: Session }>(async (c, next) => {
    c.set('session', {
      userId: 'u1',
      scopes: (c.req.header('x-scopes') ?? '').split(',').filter(Boolean),
    });
    await next();
  });

  const thingsRoute = defineChildContext(root, '/things');
  const thingRoute = defineChildContext(thingsRoute, '/:id');
  const notesRoute = defineChildContext(thingRoute, '/notes');

  const makeRouter = createRouter({
    routeMiddleware: [
      createScopeMiddleware(root, { resolve: (c) => c.var.session.scopes }),
      (route) =>
        async function readOnlyMode(c, next) {
          if (route.method !== 'get' && c.req.header('x-read-only') === '1') {
            return c.json({ error: 'E_READ_ONLY', message: 'Read-only mode' }, 403);
          }

          await next();
        },
    ],
    routeDefaults: { responses: { 403: jsonResponse(Forbidden, 'Forbidden') } },
  });

  const notes = makeRouter(notesRoute, ({ router, defineRoute }) =>
    router.openapi(
      defineRoute('get', {
        request: { params: z.object({ id: z.string() }) },
        responses: { 200: jsonResponse(z.array(z.string()), 'Notes') },
      }),
      (c) => c.json([`note for ${c.req.valid('param').id}`], 200),
    ),
  );

  const thing = makeRouter(
    thingRoute,
    ({ router, defineRoute }) =>
      router.openapi(
        defineRoute('get', {
          request: { params: z.object({ id: z.string() }) },
          responses: { 200: jsonResponse(Thing, 'Found'), 404: jsonResponse(Message, 'Missing') },
        }),
        (c) =>
          handle(
            c,
            async ({ param: { id } }) => {
              if (id === 'missing') {
                throw new ThingNotFound();
              }

              return c.json({ id, name: 'Widget' }, 200);
            },
            [onError(ThingNotFound, (_err, ec) => ec.json({ message: 'Not found' }, 404))],
          ),
      ),
    [notes],
  );

  const things = makeRouter(
    thingsRoute,
    ({ router, defineRoute }) =>
      router.openapi(
        defineRoute('post', {
          request: jsonRequest(z.object({ name: z.string() }), 'New thing'),
          responses: { 200: jsonResponse(Thing, 'Created') },
          security: [{ bearer: ['things:write'] }],
        }),
        (c) => handle(c, async ({ json }) => c.json({ id: 't1', name: json.name }, 200)),
      ),
    [thing],
  );

  const app = mountRouter(root, [things]);

  // The short form has the type of the long form.
  expectTypeOf(app).toEqualTypeOf(makeRouter(root, ({ router }) => router, [things])());

  return app;
}

describe('testClient', () => {
  const client = testClient(buildApp());

  it('calls a GET route with a typed param and reads the typed 200 body', async () => {
    const res = await client.api.things[':id'].$get({ param: { id: '42' } });

    expect(res.status).toBe(200);

    if (res.status === 200) {
      const body = await res.json();
      expectTypeOf(body).toEqualTypeOf<{ id: string; name: string }>();
      expect(body).toEqual({ id: '42', name: 'Widget' });
    }
  });

  it('reads the typed 404 body produced by an error arm', async () => {
    const res = await client.api.things[':id'].$get({ param: { id: 'missing' } });

    expectTypeOf(res.status).toEqualTypeOf<200 | 403 | 404>();
    expect(res.status).toBe(404);

    if (res.status === 404) {
      const body = await res.json();
      expectTypeOf(body).toEqualTypeOf<{ message: string }>();
      expect(body).toEqual({ message: 'Not found' });
    }
  });

  it('validates a typed JSON body: valid is 200, invalid is 400', async () => {
    const headers = { 'x-scopes': 'things:write' };
    const ok = await client.api.things.$post({ json: { name: 'Gadget' } }, { headers });

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 't1', name: 'Gadget' });

    // @ts-expect-error The request schema requires `name`.
    const bad = await client.api.things.$post({ json: {} }, { headers });

    expect(bad.status).toBe(400);
  });

  it('reaches a route nested three levels deep', async () => {
    const res = await client.api.things[':id'].notes.$get({ param: { id: '7' } });

    expect(res.status).toBe(200);

    if (res.status === 200) {
      const body = await res.json();
      expectTypeOf(body).toEqualTypeOf<string[]>();
      expect(body).toEqual(['note for 7']);
    }
  });

  it('observes a routeMiddleware 403 through the client', async () => {
    const res = await client.api.things.$post(
      { json: { name: 'Gadget' } },
      { headers: { 'x-scopes': 'things:write', 'x-read-only': '1' } },
    );

    expect(res.status).toBe(403);

    if (res.status === 403) {
      expect(await res.json()).toEqual({ error: 'E_READ_ONLY', message: 'Read-only mode' });
    }
  });

  it('observes a createScopeMiddleware 403 with the session from a context middleware', async () => {
    const res = await client.api.things.$post({ json: { name: 'Gadget' } });

    expect(res.status).toBe(403);

    if (res.status === 403) {
      const body = await res.json();
      expectTypeOf(body).toEqualTypeOf<{ error: string; message: string }>();
      expect(body).toEqual({ error: 'E_FORBIDDEN', message: 'Missing things:write scope(s)' });
    }
  });
});

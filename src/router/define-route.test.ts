import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonResponse } from '../schema-helpers';
import { createRouter } from './create-router';
import { mountRouter } from './mount';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

describe('path params from the context path', () => {
  const root = defineRootContext('/api', []);
  const orgThings = defineChildContext(root, '/orgs/:orgId/things');
  const thingById = defineChildContext(orgThings, '/:id');
  const makeRouter = createRouter();

  function mountUnderOrgThings(child: Parameters<typeof mountRouter>[1][number]) {
    return mountRouter(root, [makeRouter(orgThings, ({ app }) => app, [child])]);
  }

  function doc(app: { getOpenAPIDocument: (config: never) => unknown }) {
    return app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
    } as never) as {
      paths: Record<string, Record<string, { parameters?: { in: string; name: string }[] }>>;
    };
  }

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

    function names(method: string) {
      return operations?.[method]?.parameters?.map((p) => `${p.in}:${p.name}`).sort();
    }

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
            // `MakeRouteFn` does not accept `path`, so a cast sets it.
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

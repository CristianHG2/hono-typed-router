import { inspectRoutes, showRoutes } from 'hono/dev';
import { describe, expect, it, vi } from 'vitest';
import { z } from '@hono/zod-openapi';
import { jsonResponse } from '../schema-helpers';
import { createRouter, mountRouter } from '../router';
import { extendRouteContext } from './extend';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from './extend';
import { getRouteIdentity } from './define-context';
import { defineChildContext, defineRootContext } from './define-context';
import type { RouteContext } from './context';

type Organization = { id: string; name: string };

const organizations: Record<string, Organization> = { acme: { id: 'acme', name: 'Acme' } };

async function findOrganization(id: string) {
  return organizations[id] ?? null;
}

const okResponse = jsonResponse(z.object({ name: z.string() }), 'OK');

const valueResponse = jsonResponse(z.object({ value: z.unknown() }), 'OK');

const makeRouter = createRouter();

function valueRouter(ctx: RouteContext<string, { x: unknown }>) {
  return makeRouter(ctx, ({ app, defineRoute }) => {
    app.openapi(defineRoute('get', { responses: { 200: valueResponse } }), (c) =>
      c.json({ value: c.var.x }, 200),
    );
  });
}

function captureLog(run: () => void): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

  try {
    run();

    return spy.mock.calls.map((args) => args.join(' ')).join('\n');
  } finally {
    spy.mockRestore();
  }
}

function nameRouter(ctx: RouteContext<'/orgs/:organizationId', { organization: Organization }>) {
  return makeRouter(ctx, ({ app, defineRoute }) => {
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ name: c.var.organization.name }, 200),
    );
  });
}

describe('RouteContext.bind', () => {
  it('sets the var from the loader and runs the route', async () => {
    const ctx = defineRootContext('/orgs/:organizationId').bind(
      'organization',
      'organizationId',
      findOrganization,
    );

    const res = await nameRouter(ctx)().request('/orgs/acme');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Acme' });
  });

  it('returns the notFound response of the app when the loader gives null', async () => {
    const ctx = defineRootContext('/orgs/:organizationId').bind(
      'organization',
      'organizationId',
      findOrganization,
    );

    const app = nameRouter(ctx)();
    app.notFound((c) => c.json({ error: 'CUSTOM_NOT_FOUND' }, 404));

    const res = await app.request('/orgs/missing');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'CUSTOM_NOT_FOUND' });
  });

  it('returns 404 when the loader gives undefined', async () => {
    const ctx = defineRootContext('/orgs/:organizationId').bind(
      'organization',
      'organizationId',
      (id) => organizations[id],
    );

    const res = await nameRouter(ctx)().request('/orgs/missing');

    expect(res.status).toBe(404);
  });

  it('sends an error from the loader to app.onError', async () => {
    const ctx = defineRootContext('/orgs/:organizationId').bind(
      'organization',
      'organizationId',
      (id): Organization => {
        throw new Error(`load failed: ${id}`);
      },
    );

    const app = nameRouter(ctx)();
    app.onError((error, c) => c.json({ message: error.message }, 500));

    const res = await app.request('/orgs/acme');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: 'load failed: acme' });
  });

  it('names the middleware bind:<key> in inspectRoutes', () => {
    const ctx = defineRootContext('/orgs/:organizationId').bind(
      'organization',
      'organizationId',
      findOrganization,
    );

    expect(ctx.middlewares.map((handler) => handler.name)).toEqual(['bind:organization']);

    const entry = inspectRoutes(nameRouter(ctx)()).find((r) => r.name === 'bind:organization');
    expect(entry).toMatchObject({ isMiddleware: true, path: '/orgs/:organizationId/*' });
  });

  it('chains binds, and the loader reads the vars of the context', async () => {
    const ctx = defineRootContext('/orgs/:organizationId/teams/:teamId')
      .middleware<{ userId: string }>(async (c, next) => {
        c.set('userId', 'u1');
        await next();
      })
      .bind('organization', 'organizationId', findOrganization)
      .bind('team', 'teamId', (id, c) => `${c.var.userId}:${c.var.organization.id}:${id}`);

    const app = makeRouter(ctx, ({ app, defineRoute }) => {
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ name: c.var.team }, 200),
      );
    })();

    const res = await app.request('/orgs/acme/teams/t1');

    expect(await res.json()).toEqual({ name: 'u1:acme:t1' });
    expect(ctx.middlewares.map((handler) => handler.name)).toEqual([
      '',
      'bind:organization',
      'bind:team',
    ]);
  });

  it('returns a new context with a new identity in the lineage, as .middleware() does', () => {
    const root = defineRootContext('/orgs/:organizationId');
    const bound = root.bind('organization', 'organizationId', findOrganization);

    expect(bound).not.toBe(root);
    expect(root.middlewares).toHaveLength(0);
    expect(getRouteIdentity(bound)?.lineage).toEqual([
      ...(getRouteIdentity(root)?.lineage ?? []),
      getRouteIdentity(bound)?.id,
    ]);
  });

  it('accepts a child of a context under its bound descendant', async () => {
    const root = defineRootContext('/orgs/:organizationId');
    const child = defineChildContext(root, '/info');
    const bound = root.bind('organization', 'organizationId', findOrganization);

    const childRouter = makeRouter(child, ({ app, defineRoute }) => {
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ name: c.req.param('organizationId') }, 200),
      );
    });

    const res = await makeRouter(bound, () => {}, [childRouter])().request('/orgs/acme/info');

    expect(res.status).toBe(200);
  });

  it.each([0, '', false])('sets the falsy value %j and runs the route', async (value) => {
    const ctx = defineRootContext('/values/:id').bind('x', 'id', () => value);

    const res = await valueRouter(ctx)().request('/values/1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value });
  });

  it('runs the loader once for a HEAD request and returns 200', async () => {
    const load = vi.fn(() => 'v');
    const ctx = defineRootContext('/values/:id').bind('x', 'id', load);

    const res = await valueRouter(ctx)().request('/values/1', { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns 404 without calling the loader when the param is missing', async () => {
    const load = vi.fn((id: string) => id);
    const parent = defineRootContext('/orgs/:organizationId');
    const child = defineChildContext<typeof parent>()('/info').bind('x', 'organizationId', load);

    // The curried child router alone has the path '/info', without the param of the parent.
    const res = await valueRouter(child)().request('/info');

    expect(res.status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });

  it('gives the raw string to the loader and the coerced number to the handler', async () => {
    const load = vi.fn((id: string) => `loaded:${id}`);
    const ctx = defineRootContext('/values/:id').bind('x', 'id', load);

    const app = makeRouter(ctx, ({ app, defineRoute }) => {
      const route = defineRoute('get', {
        request: { params: z.object({ id: z.coerce.number() }) },
        responses: { 200: valueResponse },
      });

      app.openapi(route, (c) => c.json({ value: [c.req.valid('param').id, c.var.x] }, 200));
    })();

    const res = await app.request('/values/42');

    expect(await res.json()).toEqual({ value: [42, 'loaded:42'] });
    expect(load).toHaveBeenCalledWith('42', expect.anything());
  });

  it('reads the param of the parent in a curried child mounted under the parent', async () => {
    const parent = defineRootContext('/orgs/:organizationId');

    const child = defineChildContext<typeof parent>()('/info').bind(
      'x',
      'organizationId',
      (id) => `org:${id}`,
    );

    const res = await makeRouter(parent, () => {}, [valueRouter(child)])().request(
      '/orgs/acme/info',
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'org:acme' });
  });

  it('gives the URL-decoded param to the loader', async () => {
    const ctx = defineRootContext('/values/:id').bind('x', 'id', (id) => id);

    const res = await valueRouter(ctx)().request('/values/hello%20world');

    expect(await res.json()).toEqual({ value: 'hello world' });
  });

  it('sends a null from a router two levels down to the notFound of the top app', async () => {
    const root = defineRootContext('/orgs/:organizationId');
    const middle = defineChildContext(root, '/teams');

    const leaf = defineChildContext(middle, '/:teamId').bind(
      'x',
      'teamId',
      (): string | null => null,
    );

    const middleRouter = makeRouter(middle, () => {}, [valueRouter(leaf)]);
    const app = makeRouter(root, () => {}, [middleRouter])();
    app.notFound((c) => c.json({ error: 'TOP_NOT_FOUND' }, 404));

    const res = await app.request('/orgs/acme/teams/t1');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'TOP_NOT_FOUND' });
  });

  it('runs the loader for a sibling mounted after the bound router under the same segment', async () => {
    const load = vi.fn((id: string) => id);
    const parent = defineRootContext('/orgs');
    const bound = defineChildContext(parent, '/:organizationId').bind('x', 'organizationId', load);
    const sibling = defineChildContext(parent, '/:organizationId/settings');

    const siblingRouter = makeRouter(sibling, ({ app, defineRoute }) => {
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ name: 'settings' }, 200),
      );
    });

    const boundFirst = makeRouter(parent, () => {}, [valueRouter(bound), siblingRouter])();
    await boundFirst.request('/orgs/acme/settings');

    expect(load).toHaveBeenCalledTimes(1);

    load.mockClear();
    const siblingFirst = makeRouter(parent, () => {}, [siblingRouter, valueRouter(bound)])();
    await siblingFirst.request('/orgs/acme/settings');

    expect(load).not.toHaveBeenCalled();
  });

  it('names the middleware in the verbose output of showRoutes only', () => {
    const ctx = defineRootContext('/values/:id').bind('x', 'id', () => 1);
    const app = valueRouter(ctx)();

    expect(captureLog(() => showRoutes(app, { verbose: true }))).toContain('bind:x');
    expect(captureLog(() => showRoutes(app))).not.toContain('bind:x');
  });

  it('keeps the mount guard for a child of a bound context', () => {
    const root = defineRootContext('/orgs/:organizationId');
    const bound = root.bind('organization', 'organizationId', findOrganization);
    const child = defineChildContext(bound, '/info');

    const childRouter = makeRouter(child, ({ app, defineRoute }) => {
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ name: c.var.organization.name }, 200),
      );
    });

    expect(() => makeRouter(root, () => {}, [childRouter])()).toThrow(TypeError);
    expect(() => makeRouter(root, () => {}, [childRouter])()).toThrowError(
      /mounted under an ancestor or an unrelated context with the same path '\/orgs\/:organizationId'/,
    );
  });

  it('keeps the mount guard for a child of a bound context in mountRouter', () => {
    const root = defineRootContext('/orgs/:organizationId');
    const bound = root.bind('x', 'organizationId', findOrganization);
    const childRouter = valueRouter(defineChildContext(bound, '/info'));

    expect(() => mountRouter(root, [childRouter])).toThrowError(
      /mounted under an ancestor or an unrelated context with the same path '\/orgs\/:organizationId'/,
    );
  });
});

interface Ctx<TPath extends string, TVars extends object> extends RouteContextBase<
  CtxKind,
  TPath,
  TVars
> {
  withFlag: () => ReaugmentContext<CtxKind, TPath, TVars & { flag: boolean }>;
}

interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

describe('RouteContextBase.bind', () => {
  const extended = extendRouteContext<CtxKind>({
    withFlag: (ctx) => () =>
      ctx.middleware(async function setFlag(c, next) {
        c.set('flag' as never, true as never);
        await next();
      }),
  });

  it('keeps the builders of the extension after .bind()', async () => {
    const ctx = extended
      .defineRootContext('/orgs/:organizationId')
      .bind('organization', 'organizationId', findOrganization)
      .withFlag()
      .bind('team', 'organizationId', (id, c) => `${id}:${String(c.var.flag)}`);

    expect(ctx.withFlag).toBeTypeOf('function');
    expect(ctx.middlewares.map((handler) => handler.name)).toEqual([
      'bind:organization',
      'setFlag',
      'bind:team',
    ]);

    const app = makeRouter(ctx, ({ app, defineRoute }) => {
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ name: `${c.var.organization.name}:${c.var.team}` }, 200),
      );
    })();

    expect(await (await app.request('/orgs/acme')).json()).toEqual({ name: 'Acme:acme:true' });
  });
});

// The README examples, inlined as type-level code so `test:types` catches doc drift.
// Keep each block in sync with the README section named in its comment. Stubs
// (`declare`) stand in for the reader's own code; nothing here runs.
import { OpenAPIHono } from '@hono/zod-openapi';
import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { testClient } from 'hono/testing';
import type { ParamKeys } from 'hono/types';
import { z } from 'zod';
import {
  createRouter,
  defineChildRoute,
  defineRootRoute,
  extendRouteContext,
  handle,
  jsonRequest,
  jsonResponse,
  matchErrors,
  onError,
  rethrow,
} from './index';
import type {
  ContextEnv,
  ReaugmentContext,
  RouteContext,
  RouteContextBase,
  RouteContextKind,
} from './index';
import { createScopeMiddleware } from './scopes';

// README "Quick start".
const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const rootRoute = defineRootRoute('/api', []);

const makeRouter = createRouter();

const thingsRoute = defineChildRoute(rootRoute, '/things');

const thingsRouter = makeRouter(thingsRoute, ({ router, defineRoute }) => {
  const list = defineRoute('get', { responses: { 200: okResponse } });

  return router.openapi(list, (c) => c.json({ ok: true }, 200));
});

const app = makeRouter(rootRoute, ({ router }) => router, [thingsRouter])();

expectTypeOf(thingsRoute.path).toEqualTypeOf<'/api/things'>();

expectTypeOf(app.request).toBeFunction();

// README "`.middleware<NewVars>(handler)`" (value-form child inherits the vars).
type SessionVar = { session: { userId: string } };

declare const loadSession: (c: unknown) => Promise<SessionVar['session']>;

const authed = defineRootRoute('/api', []).middleware<SessionVar>(async (c, next) => {
  c.set('session', await loadSession(c));
  await next();
});

const meRoute = defineChildRoute(authed, '/me');

expectTypeOf(meRoute.path).toEqualTypeOf<'/api/me'>();

expectTypeOf(meRoute.vars).toEqualTypeOf<SessionVar>();

// README "`.middleware<NewVars>(handler)`" (reusable middleware with `createMiddleware`).
{
  type Session = { userId: string; scopes: string[] };

  const findSession = async (_header: string | undefined): Promise<Session | null> => null;

  const requireSession = createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    const session = await findSession(c.req.header('authorization'));

    if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('session', session);
    await next();
  });

  const apiRoute = defineRootRoute('/api', []).middleware<{ session: Session }>(requireSession);
  const adminRoute = defineRootRoute('/admin', []).middleware<{ session: Session }>(requireSession);

  const loadTenant = createMiddleware<ContextEnv<typeof apiRoute, { tenantId: string }>>(
    async (c, next) => {
      c.set('tenantId', `tenant-of-${c.var.session.userId}`);
      await next();
    },
  );

  const tenantRoute = apiRoute.middleware<{ tenantId: string }>(loadTenant);

  expectTypeOf(apiRoute.vars).toEqualTypeOf<{ session: Session }>();
  expectTypeOf(adminRoute.vars).toEqualTypeOf<{ session: Session }>();
  expectTypeOf<keyof typeof tenantRoute.vars>().toEqualTypeOf<'session' | 'tenantId'>();
}

// README "Using multiple middlewares".
{
  const calls: string[] = [];

  const timing = createMiddleware(async (c, next) => {
    calls.push('timing');
    const start = Date.now();
    await next();
    c.header('Server-Timing', `total;dur=${Date.now() - start}`);
  });

  const noStore = createMiddleware(async (c, next) => {
    calls.push('noStore');
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const rootRoute = defineRootRoute('/api', [timing, noStore])
    .middleware<{ requestId: string }>(async (c, next) => {
      calls.push('requestId');
      c.set('requestId', c.req.header('x-request-id') ?? 'none');
      await next();
    })
    .middleware<{ log: (message: string) => void }>(async (c, next) => {
      calls.push('log');
      c.set('log', (message) => console.info(`[${c.var.requestId}] ${message}`));
      await next();
    });

  const makeRouter = createRouter({
    routeMiddleware: [
      (route) =>
        async function audit(_c, next) {
          calls.push(`audit:${route.method}`);
          await next();
        },
      () =>
        async function rateLimit(_c, next) {
          calls.push('rateLimit');
          await next();
        },
    ],
  });

  const app = makeRouter(rootRoute, ({ router, defineRoute }) => {
    const search = defineRoute('get', {
      request: { query: z.object({ q: z.string() }) },
      responses: { 200: jsonResponse(z.object({ q: z.string() }), 'OK') },
    });

    return router.openapi(search, (c) => {
      calls.push('handler');
      const { q } = c.req.valid('query');
      c.var.log(`search ${q}`);

      return c.json({ q }, 200);
    });
  })();

  expectTypeOf(rootRoute.vars).toEqualTypeOf<
    { requestId: string } & { log: (message: string) => void }
  >();
  expectTypeOf(app.request).toBeFunction();
}

// README "Type-safe error handling" (first example: `matchErrors` with `rethrow`).
class CartNotFound extends Error {
  readonly _tag = 'CartNotFound' as const;
}

class OutOfStock extends Error {
  readonly _tag = 'OutOfStock' as const;
  constructor(readonly sku: string) {
    super();
  }
}

class Legacy extends Error {
  override readonly name = 'Legacy' as const;
}

declare const checkoutCart: (id: string) => Promise<{ orderId: string }>;

const ErrorBody = z.object({ message: z.string() });

makeRouter(defineChildRoute(rootRoute, '/carts/:id/checkout'), ({ router, defineRoute }) => {
  const checkout = defineRoute('post', {
    request: { params: z.object({ id: z.string() }) },
    responses: {
      201: jsonResponse(z.object({ orderId: z.string() }), 'Order'),
      404: jsonResponse(ErrorBody, 'Not found'),
      409: jsonResponse(ErrorBody, 'Conflict'),
    },
  });

  return router.openapi(checkout, (c) =>
    handle(
      c,
      async ({ param }) => c.json(await checkoutCart(param.id), 201),
      matchErrors([CartNotFound, OutOfStock, Legacy], {
        CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
        OutOfStock: (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
        Legacy: () => rethrow(),
      }),
    ),
  );
});

// The handler map is exhaustive.
// @ts-expect-error — `Legacy` has no handler
matchErrors([CartNotFound, Legacy], {
  CartNotFound: () => rethrow(),
});

// README "Type-safe error handling" (second example: `matchErrors` mixed with `onError`).
class RecordNotFoundError extends Error {}

declare const findOrFail: (id: string) => Promise<{ id: string }>;

const Thing = z.object({ id: z.string() });

const NotFound = z.object({ message: z.string() });

const thingRouter = makeRouter(
  defineChildRoute(rootRoute, '/things/:id'),
  ({ router, defineRoute }) => {
    const getThing = defineRoute('get', {
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: jsonResponse(Thing, 'A thing'), 404: jsonResponse(NotFound, 'Not found') },
    });

    return router.openapi(getThing, (c) =>
      handle(c, async ({ param: { id } }) => c.json(await findOrFail(id), 200), [
        ...matchErrors([CartNotFound], {
          CartNotFound: (_e, ec) => ec.json({ message: 'Not found' }, 404),
        }),
        onError(RecordNotFoundError, (_err, ec) => ec.json({ message: 'Not found' }, 404)),
      ]),
    );
  },
);

// README "Testing".
const testedApp = makeRouter(rootRoute, ({ router }) => router, [thingsRouter, thingRouter])();

const client = testClient(testedApp);

async function readThing() {
  const res = await client.api.things[':id'].$get({ param: { id: '42' } });

  if (res.status === 200) {
    expectTypeOf(await res.json()).toEqualTypeOf<{ id: string }>();
  }

  if (res.status === 404) {
    expectTypeOf(await res.json()).toEqualTypeOf<{ message: string }>();
  }
}

expectTypeOf(readThing).toBeFunction();

expectTypeOf(client.api.things.$get).toBeFunction();

// README "Extending the `define[x]` context" (no cast in the builder).
type RelationsFor<TRepo> = { repository: TRepo; id: string };

declare const relationsFor: <TRepo>(repository: TRepo, id: string) => RelationsFor<TRepo>;

declare const organizationsRepository: { findById: (id: string) => Promise<unknown> };

interface Ctx<TPath extends string, TVars extends object> extends RouteContextBase<
  CtxKind,
  TPath,
  TVars
> {
  bindRepository: <TKey extends string, TRepo>(
    key: TKey extends keyof TVars ? `Cannot redeclare existing var: "${TKey}"` : TKey,
    param: ParamKeys<TPath>,
    repository: () => TRepo,
  ) => ReaugmentContext<CtxKind, TPath, TVars & { [K in TKey]: RelationsFor<TRepo> }>;
}

interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

const extended = extendRouteContext<CtxKind>({
  bindRepository: (ctx) => (key, param, repository) => {
    const mw: MiddlewareHandler = async (c, next) => {
      c.set(key, relationsFor(repository(), c.req.param(param)));
      await next();
    };

    return ctx.middleware(mw);
  },
});

const orgRoute = extended
  .defineChildRoute(rootRoute, '/organizations/:organizationId')
  .bindRepository('organization', 'organizationId', () => organizationsRepository);

expectTypeOf(orgRoute.path).toEqualTypeOf<'/api/organizations/:organizationId'>();

expectTypeOf(orgRoute.vars.organization).toEqualTypeOf<
  RelationsFor<typeof organizationsRepository>
>();

expectTypeOf(orgRoute.bindRepository).toBeFunction();

type Membership = { role: 'owner' | 'member' };

declare const teamsRepository: { findById: (id: string) => Promise<unknown> };

declare const findMembership: (
  organization: RelationsFor<typeof organizationsRepository>,
  team: RelationsFor<typeof teamsRepository>,
) => Promise<Membership>;

// README "Extending the `define[x]` context": two chained builders plus `.middleware()`.
{
  const { defineChildRoute } = extended;

  const teamRoute = defineChildRoute(rootRoute, '/organizations/:organizationId/teams/:teamId')
    .bindRepository('organization', 'organizationId', () => organizationsRepository)
    .bindRepository('team', 'teamId', () => teamsRepository)
    .middleware<{ membership: Membership }>(async (c, next) => {
      // `c.var.organization` and `c.var.team` are typed here.
      c.set('membership', await findMembership(c.var.organization, c.var.team));
      await next();
    });

  expectTypeOf(teamRoute.path).toEqualTypeOf<'/api/organizations/:organizationId/teams/:teamId'>();
  expectTypeOf(teamRoute.vars.organization).toEqualTypeOf<
    RelationsFor<typeof organizationsRepository>
  >();
  expectTypeOf(teamRoute.vars.team).toEqualTypeOf<RelationsFor<typeof teamsRepository>>();
  expectTypeOf(teamRoute.vars.membership).toEqualTypeOf<Membership>();
  expectTypeOf(teamRoute.bindRepository).toBeFunction();

  const withOrganization = defineChildRoute(
    rootRoute,
    '/organizations/:organizationId/teams/:teamId',
  ).bindRepository('organization', 'organizationId', () => organizationsRepository);

  // @ts-expect-error a second bind with the same key is a compile error
  withOrganization.bindRepository('organization', 'teamId', () => teamsRepository);

  // @ts-expect-error `param` must be a parameter of the context's path
  withOrganization.bindRepository('team', 'userId', () => teamsRepository);
}

// README "Binding a repository to a path parameter".
{
  interface Organization {
    id: string;
  }

  const organizationsRepository = {
    findById: async (_id: string): Promise<Organization | null> => null,
  };

  const bindOrganization = <P extends string>(ctx: RouteContext<P, {}>, param: ParamKeys<P>) =>
    ctx.middleware<{ organization: Organization }>(async (c, next) => {
      const id = c.req.param(param);
      const organization = id ? await organizationsRepository.findById(id) : null;

      if (!organization) return c.json({ error: 'NOT_FOUND' }, 404);
      c.set('organization', organization);
      await next();
    });

  const orgContext = defineChildRoute(rootRoute, '/organizations/:organizationId');
  const orgRoute = bindOrganization(orgContext, 'organizationId');
  expectTypeOf(orgRoute.vars).toEqualTypeOf<{ organization: Organization }>();
  expectTypeOf(orgRoute.path).toEqualTypeOf<'/api/organizations/:organizationId'>();

  // Nested inline, `P` still infers from the context's path (no `NoInfer` needed).
  const inlineRoute = bindOrganization(
    defineChildRoute(rootRoute, '/organizations/:organizationId'),
    'organizationId',
  );

  expectTypeOf(inlineRoute.path).toEqualTypeOf<'/api/organizations/:organizationId'>();
}

// README "Complete example" (one router with child routers). The file-based layout of the
// same section is not mirrored here, because it needs real module files.
type ExampleSession = { userId: string; scopes: string[] };

type ThingRecord = { id: string; name: string; ownerId: string };

declare const verifySession: (header: string | undefined) => Promise<ExampleSession | null>;

declare const listThings: (userId: string) => Promise<ThingRecord[]>;

declare const createThing: (userId: string, input: { name: string }) => Promise<ThingRecord>;

declare const findThing: (id: string) => Promise<ThingRecord>;

{
  class ThingNotFound extends Error {
    readonly _tag = 'ThingNotFound' as const;
  }

  const Thing = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
  const CreateThing = z.object({ name: z.string().min(1) });
  const ErrorBody = z.object({ error: z.string() });

  const rootRoute = defineRootRoute('/api', []).middleware<{
    session: { userId: string; scopes: string[] };
  }>(async function authenticate(c, next) {
    const session = await verifySession(c.req.header('authorization'));

    if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('session', session);
    await next();
  });

  const makeRouter = createRouter({
    routeDefaults: { responses: { 401: jsonResponse(ErrorBody, 'Unauthorized') } },
    routeMiddleware: [
      createScopeMiddleware({ resolve: (c) => c.var.session.scopes }),
      (route, meta) =>
        async function logRequest(c, next) {
          await next();
          console.info(`${route.method} ${meta.path} -> ${c.res.status}`);
        },
    ],
    transformRoute: (config, meta) => ({
      ...config,
      operationId:
        config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
    }),
  });

  // Contexts in variables: a value-form `defineChildRoute(...)` nested inline in another
  // generic call infers its path as `string`.
  const thingsRoute = defineChildRoute(rootRoute, '/things');
  const thingByIdRoute = defineChildRoute(thingsRoute, '/:id');

  expectTypeOf(thingByIdRoute.path).toEqualTypeOf<'/api/things/:id'>();

  expectTypeOf(thingByIdRoute.vars).toEqualTypeOf<{ session: ExampleSession }>();

  const thingByIdRouter = makeRouter(thingByIdRoute, ({ router, defineRoute }) => {
    const read = defineRoute('get', {
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: jsonResponse(Thing, 'The thing'),
        404: jsonResponse(ErrorBody, 'Not found'),
      },
    });

    return router.openapi(read, (c) =>
      handle(
        c,
        async ({ param: { id } }) => c.json(await findThing(id), 200),
        matchErrors([ThingNotFound], {
          ThingNotFound: (_e, ec) => ec.json({ error: 'NOT_FOUND' }, 404),
        }),
      ),
    );
  });

  const thingsRouter = makeRouter(
    thingsRoute,
    ({ router, defineRoute }) => {
      const list = defineRoute('get', {
        responses: { 200: jsonResponse(z.array(Thing), 'The things of the user') },
      });

      const create = defineRoute('post', {
        request: jsonRequest(CreateThing, 'The new thing'),
        responses: { 201: jsonResponse(Thing, 'The created thing') },
        security: [{ bearer: ['things:write'] }],
      });

      return router
        .openapi(list, async (c) => c.json(await listThings(c.var.session.userId), 200))
        .openapi(create, async (c) =>
          c.json(await createThing(c.var.session.userId, c.req.valid('json')), 201),
        );
    },
    [thingByIdRouter],
  );

  const app = makeRouter(rootRoute, ({ router }) => router, [thingsRouter])();

  const server = new OpenAPIHono().route('/', app);
  server.doc('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Things API', version: '1.0.0' },
  });

  const client = testClient(server);

  const readMissingThing = async () => {
    const res = await client.api.things[':id'].$get({ param: { id: 'nope' } });
    expectTypeOf(res.status).toEqualTypeOf<200 | 401 | 404>();

    if (res.status === 404) {
      expectTypeOf(await res.json()).toEqualTypeOf<{ error: string }>();
    }

    // @ts-expect-error — `name` is required by the request schema
    await client.api.things.$post({ json: {} });
  };

  expectTypeOf(readMissingThing).toBeFunction();
}

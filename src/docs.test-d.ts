// The README examples, inlined as type-level code so `test:types` catches doc drift.
// Keep each block in sync with the README section named in its comment. Stubs
// (`declare`) stand in for the reader's own code; nothing here runs.
import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { testClient } from 'hono/testing';
import type { ParamKeys } from 'hono/types';
import { z } from 'zod';
import {
  createRouter,
  defineChildRoute,
  defineRootRoute,
  extendRouteContext,
  handle,
  jsonResponse,
  matchErrors,
  onError,
  rethrow,
} from './index';
import type { ReaugmentContext, RouteContext, RouteContextBase, RouteContextKind } from './index';

// README "Quick start".
const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const rootRoute = defineRootRoute('/api', []);

const makeRouter = createRouter();

const thingsRoute = defineChildRoute(rootRoute, '/things');

const thingsRouter = makeRouter(thingsRoute, ({ router, route }) => {
  const list = route('get', { responses: { 200: okResponse } });

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

makeRouter(defineChildRoute(rootRoute, '/carts/:id/checkout'), ({ router, route }) => {
  const checkout = route('post', {
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

const thingRouter = makeRouter(defineChildRoute(rootRoute, '/things/:id'), ({ router, route }) => {
  const getThing = route('get', {
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
});

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

// README "Binding a repository to a path parameter".
{
  interface Organization {
    id: string;
  }

  const organizationsRepository = {
    findById: async (_id: string): Promise<Organization | null> => null,
  };

  const bindOrganization = <P extends string>(
    ctx: RouteContext<P, {}>,
    param: NoInfer<ParamKeys<P>>,
  ) =>
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
}

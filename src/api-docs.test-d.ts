// The docs/api.md examples as type-level code. `test:types` compiles them, and nothing here runs.
// `pnpm check:docs` finds each api.md ```ts block here after normalization.
// Setup and stubs go before each block, never inside it.
// api.md marks the signature-only blocks as skipped.
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { testClient } from 'hono/testing';
import type { ZodType } from 'zod';
import { z } from 'zod';
import {
  createRouter,
  defineChildContext,
  defineRootContext,
  emptyResponse,
  handle,
  jsonBody,
  jsonRequest,
  jsonResponse,
  matchErrors,
  mountRouter,
  rethrow,
} from './index';
import type { ChildRouter, ContextEnv } from './index';

interface Session {
  userId: string;
}

interface SessionVars {
  session: Session;
}

interface Organization {
  id: string;
  name: string;
}

declare const organizationsRepository: {
  findForMember: (id: string, userId: string) => Promise<Organization | null>;
};

declare const schema: ZodType;

declare const description: string;

declare const checkoutCart: (id: string) => Promise<{ orderId: string }>;

declare const readSession: (c: unknown) => Promise<{ userId: string }>;

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

// api.md "`defineRootContext(path, middlewares?)`": the root array example.
{
  const timing = createMiddleware(async function timing(_c, next) {
    await next();
  });

  interface RequestIdVars {
    requestId: string;
  }

  interface LogVars {
    log: (message: string) => void;
  }

  const setRequestId = createMiddleware<{ Variables: RequestIdVars }>(
    async function setRequestId(c, next) {
      c.set('requestId', c.req.header('x-request-id') ?? 'none');
      await next();
    },
  );

  const setLog = createMiddleware<{ Variables: LogVars }>(async function setLog(c, next) {
    c.set('log', (message) => console.info(message));
    await next();
  });

  const loggedContext = defineRootContext('/logged', [timing, setRequestId, setLog]);

  expectTypeOf<keyof typeof loggedContext.vars>().toEqualTypeOf<'requestId' | 'log'>();
  expectTypeOf(loggedContext.vars.log).toEqualTypeOf<(message: string) => void>();

  // One typed middleware gives its vars, untyped ones give `{}`.
  expectTypeOf(defineRootContext('/a', [timing, setRequestId]).vars).toEqualTypeOf<RequestIdVars>();
  expectTypeOf(defineRootContext('/a', [timing]).vars).toEqualTypeOf<{}>();

  // An array variable with mixed middlewares has one union element type.
  const list = [setRequestId, setLog];
  // @ts-expect-error Pass the middlewares as a tuple literal or as const
  defineRootContext('/a', list);
  expectTypeOf(defineRootContext('/a', [setRequestId, setLog] as const).vars.log).toBeFunction();
}

// api.md "`defineChildContext(parent, path)`": the curried form.
{
  const apiContext = defineRootContext('/api');

  const thingsContext = defineChildContext<typeof apiContext>()('/things');

  expectTypeOf(thingsContext.path).toEqualTypeOf<'/api/things'>();
}

// api.md "`RouteContext<TPath, TVars>`": an inline arrow with a type argument.
{
  interface SessionVars {
    session: { userId: string };
  }

  const authedContext = defineRootContext('/api').middleware<SessionVars>(
    async function loadSession(c, next) {
      c.set('session', await readSession(c));
      await next();
    },
  );

  const meContext = defineChildContext(authedContext, '/me');

  expectTypeOf(meContext.path).toEqualTypeOf<'/api/me'>();
  expectTypeOf(meContext.vars).toEqualTypeOf<SessionVars>();
}

// api.md "`RouteContext<TPath, TVars>`": a reusable middleware, and its second application.
{
  const findSession = async (
    _header: string | undefined,
  ): Promise<{ userId: string; scopes: string[] } | null> => null;

  interface Session {
    userId: string;
    scopes: string[];
  }

  interface SessionVars {
    session: Session;
  }

  const requireSession = createMiddleware<{ Variables: SessionVars }>(
    async function requireSession(c, next) {
      const session = await findSession(c.req.header('authorization'));

      if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
      c.set('session', session);
      await next();
    },
  );

  const apiContext = defineRootContext('/api').middleware(requireSession);
  const adminContext = defineRootContext('/admin').middleware(requireSession);

  expectTypeOf(apiContext.vars).toEqualTypeOf<SessionVars>();
  expectTypeOf(adminContext.vars).toEqualTypeOf<SessionVars>();

  apiContext.middleware(requireSession);
  // @ts-expect-error Cannot redeclare existing var: session
  apiContext.middleware<SessionVars>(requireSession);

  // The second application adds no vars.
  const twice = apiContext.middleware(requireSession);

  expectTypeOf<keyof typeof twice.vars>().toEqualTypeOf<'session'>();

  // `NoRedeclare` also rejects a redeclared var on an inline middleware.
  // @ts-expect-error Cannot redeclare existing var: session
  apiContext.middleware<SessionVars>(async (_c, next) => {
    await next();
  });

  // A set-only middleware also fits a context that has other vars.
  interface RequestIdVars {
    requestId: string;
  }

  const trackedContext = defineRootContext('/tracked')
    .middleware<RequestIdVars>(async function setRequestId(c, next) {
      c.set('requestId', crypto.randomUUID());
      await next();
    })
    .middleware(requireSession);

  expectTypeOf<keyof typeof trackedContext.vars>().toEqualTypeOf<'requestId' | 'session'>();

  interface TenantVars {
    tenantId: string;
  }

  const loadTenant = createMiddleware<ContextEnv<typeof apiContext, TenantVars>>(
    async function loadTenant(c, next) {
      c.set('tenantId', `tenant-of-${c.var.session.userId}`);
      await next();
    },
  );

  // A child of `apiContext` has the vars of `apiContext`, so `loadTenant` also fits it.
  const thingsTenantContext = defineChildContext(apiContext, '/things').middleware(loadTenant);

  expectTypeOf<keyof typeof thingsTenantContext.vars>().toEqualTypeOf<'session' | 'tenantId'>();

  // @ts-expect-error This middleware reads vars that the context does not have: session
  defineRootContext('/public').middleware(loadTenant);

  // @ts-expect-error do not give a type argument for a `ContextEnv` middleware
  apiContext.middleware<TenantVars>(loadTenant);

  // A flat type sets all its vars: `session` is a redeclaration on `apiContext`.
  const flatTenant = createMiddleware<{ Variables: { session: Session; tenantId: string } }>(
    async function flatTenant(c, next) {
      c.set('tenantId', c.var.session.userId);
      await next();
    },
  );

  // @ts-expect-error Cannot redeclare existing var: session
  apiContext.middleware(flatTenant);
}

// api.md "`.bind(key, param, load)`".
{
  const authedContext = defineRootContext('/api').middleware<SessionVars>(async (_c, next) => {
    await next();
  });

  const organizationContext = defineChildContext(
    authedContext,
    '/organizations/:organizationId',
  ).bind('organization', 'organizationId', (id, c) =>
    organizationsRepository.findForMember(id, c.var.session.userId),
  );

  expectTypeOf(organizationContext.vars).toEqualTypeOf<
    SessionVars & { organization: Organization }
  >();

  // @ts-expect-error Cannot redeclare existing var: session
  organizationContext.bind('session', 'organizationId', () => ({ userId: 'user' }));

  // @ts-expect-error `param` must be a param of the context path
  organizationContext.bind('team', 'teamId', () => ({ id: 'team' }));
}

// api.md "`ContextEnv<TContext, TNewVars>`" (the `createMiddleware` example).
{
  const apiContext = defineRootContext('/api').middleware<SessionVars>(async (_c, next) => {
    await next();
  });

  interface TenantVars {
    tenantId: string;
  }

  const loadTenant = createMiddleware<ContextEnv<typeof apiContext, TenantVars>>(
    async function loadTenant(c, next) {
      c.set('tenantId', `tenant-of-${c.var.session.userId}`);
      await next();
    },
  );

  const tenantContext = apiContext.middleware(loadTenant);

  expectTypeOf(tenantContext.vars).toEqualTypeOf<SessionVars & TenantVars>();
}

// api.md "`createRouter(options?)`": `routeMiddleware`, `routeDefaults` and `transformRoute`.
{
  const makeRouter = createRouter({
    routeMiddleware: [
      (route, meta) =>
        async function logHit(_c, next) {
          console.log('hit', route.method, meta.path);
          await next();
        },
    ],
  });

  expectTypeOf(makeRouter).toBeFunction();
}

{
  const thingsContext = defineChildContext(defineRootContext('/api'), '/things');

  const unauthorizedResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');

  const makeRouter = createRouter({
    routeDefaults: { responses: { 401: unauthorizedResponse } },
  });

  const thingsRouter = makeRouter(thingsContext, ({ app, defineRoute }) => {
    const listThingsRoute = defineRoute('get', { responses: { 200: okResponse } });

    return app.openapi(listThingsRoute, (c) => c.json({ ok: true }, 200));
  });

  expectTypeOf(thingsRouter).toBeFunction();

  makeRouter(thingsContext, ({ app, defineRoute }) => {
    const listThingsRoute = defineRoute('get', { responses: { 200: okResponse } });

    expectTypeOf<keyof typeof listThingsRoute.responses>().toEqualTypeOf<200 | 401>();

    return app.openapi(listThingsRoute, (c) => c.json({ ok: true }, 200));
  });

  // `routeDefaults.middleware` and a route `middleware`, both tuples: the handler gets both.
  interface RequestIdVars {
    requestId: string;
  }

  interface StartVars {
    startedAt: number;
  }

  const setRequestId = createMiddleware<{ Variables: RequestIdVars }>(async (c, next) => {
    c.set('requestId', 'id');
    await next();
  });

  const markStart = createMiddleware<{ Variables: StartVars }>(async (c, next) => {
    c.set('startedAt', 0);
    await next();
  });

  createRouter({ routeDefaults: { middleware: [setRequestId] } })(
    defineRootContext('/defaults'),
    ({ app, defineRoute }) =>
      app.openapi(
        defineRoute('get', { middleware: [markStart], responses: { 200: okResponse } }),
        (c) => {
          expectTypeOf(c.var.requestId).toEqualTypeOf<string>();
          expectTypeOf(c.var.startedAt).toEqualTypeOf<number>();

          return c.json({ ok: true }, 200);
        },
      ),
  );

  // A route `middleware` array literal stays a tuple. A `MiddlewareHandler[]` variable does not.
  createRouter()(defineRootContext('/mw'), ({ app, defineRoute }) => {
    const startOnly: MiddlewareHandler[] = [markStart];

    return app
      .openapi(
        defineRoute('get', {
          middleware: [markStart, setRequestId],
          responses: { 200: okResponse },
        }),
        (c) => {
          expectTypeOf(c.var.startedAt).toEqualTypeOf<number>();

          return c.json({ ok: true }, 200);
        },
      )
      .openapi(
        defineRoute('post', { middleware: startOnly, responses: { 200: okResponse } }),
        (c) => {
          // @ts-expect-error a `MiddlewareHandler[]` variable has no tuple type: `startedAt` is lost
          void c.var.startedAt;

          return c.json({ ok: true }, 200);
        },
      );
  });
}

{
  const makeRouter = createRouter({
    transformRoute: (route) => ({
      ...route,
      tags: [...(route.tags ?? []), route.method === 'get' ? 'read' : 'write'],
    }),
  });

  expectTypeOf(makeRouter).toBeFunction();
}

// api.md "`makeRouter(context, callback, children)`": the children array.
{
  const makeRouter = createRouter();
  const thingsContext = defineChildContext(defineRootContext('/api'), '/things');
  const statsContext = defineChildContext(thingsContext, '/stats');
  const thingByIdContext = defineChildContext(thingsContext, '/:id');

  const statsRouter = makeRouter(statsContext, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) =>
    app.openapi(defineRoute('delete', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const thingsChildren = [statsRouter, thingByIdRouter] as const;
  const thingsRouter = makeRouter(thingsContext, () => {}, thingsChildren);

  const client = testClient(thingsRouter());

  expectTypeOf(client.api.things.stats.$get).toBeFunction();
  expectTypeOf(client.api.things[':id'].$delete).toBeFunction();

  const plainChildren = [statsRouter, thingByIdRouter];
  // @ts-expect-error Pass children inline or as const: a children array variable has one element type, and the app type can lose the routes of some children
  makeRouter(thingsContext, () => {}, plainChildren);
  // A one-element array variable is also an error.
  const oneChild = [statsRouter];
  // @ts-expect-error Pass children inline or as const
  makeRouter(thingsContext, () => {}, oneChild);

  // `ChildRouter[]` opts out of the check. The app type then has no routes of these children.
  const untypedChildren: ChildRouter[] = [statsRouter, thingByIdRouter];

  expectTypeOf(makeRouter(thingsContext, () => {}, untypedChildren)).toBeFunction();

  // An explicit `undefined` selects the overload with children.
  expectTypeOf(makeRouter(thingsContext, () => {}, undefined)).toBeFunction();

  // An inline `makeRouter(...)` in `children` keeps the routes of the inner router.
  const nested = makeRouter(defineRootContext('/api'), ({ app }) => app, [
    makeRouter(
      thingsContext,
      ({ app, defineRoute }) =>
        app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        ),
      thingsChildren,
    ),
  ]);

  const nestedClient = testClient(nested());

  expectTypeOf(nestedClient.api.things.$get).toBeFunction();
  expectTypeOf(nestedClient.api.things.stats.$get).toBeFunction();
  expectTypeOf(nestedClient.api.things[':id'].$delete).toBeFunction();
}

// api.md "`makeRouter(context, callback, children)`": a root without routes.
{
  const makeRouter = createRouter();
  const apiContext = defineRootContext('/api');

  const thingsRouter = makeRouter(
    defineChildContext(apiContext, '/things'),
    ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
  );

  const app = makeRouter(apiContext, ({ app }) => app, [thingsRouter])();
  const sameApp = mountRouter(apiContext, [thingsRouter]);

  expectTypeOf(sameApp).toEqualTypeOf<typeof app>();
}

// api.md "`makeRouter(context, callback, children)`": path params.
{
  const makeRouter = createRouter();
  const apiContext = defineRootContext('/api');

  const thingByIdContext = defineChildContext(apiContext, '/things/:id');

  const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const getThingRoute = defineRoute('get', {
      request: { params: z.object({ id: z.coerce.number() }) },
      responses: { 200: okResponse },
    });

    return app.openapi(getThingRoute, (c) => {
      const { id } = c.req.valid('param');

      return c.json({ ok: id > 0 }, 200);
    });
  });

  expectTypeOf(thingByIdRouter).toBeFunction();

  makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const deleteThingRoute = defineRoute('delete', { responses: { 200: okResponse } });

    defineRoute('put', {
      // @ts-expect-error The path '/api/things/:id' has no param named 'thingId'
      request: { params: z.object({ thingId: z.string() }) },
      responses: { 200: okResponse },
    });

    return app.openapi(deleteThingRoute, (c) =>
      // @ts-expect-error the route declares no body, so `handle` has no `json`
      handle(c, async ({ param, json }) => c.json({ ok: param.id === String(json) }, 200)),
    );
  });
}

// api.md "`mountRouter(context, children)`".
{
  const root = defineRootContext('/api');

  const makeRouter = createRouter();

  const thingsRouter = makeRouter(defineChildContext(root, '/things'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = mountRouter(root, [thingsRouter]);

  expectTypeOf(app.request).toBeFunction();
}

// api.md "Schema helpers".
{
  jsonResponse(schema, description);
  jsonBody(schema, description);
  jsonRequest(schema, description);
  emptyResponse(description);
}

// api.md "`matchErrors(errors, handlers)`".
{
  const app = new OpenAPIHono();

  const ErrorBody = z.object({ message: z.string() });

  const checkout = createRoute({
    method: 'post',
    path: '/carts/{id}/checkout',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      201: jsonResponse(z.object({ orderId: z.string() }), 'Order'),
      404: jsonResponse(ErrorBody, 'Not found'),
      409: jsonResponse(ErrorBody, 'Conflict'),
    },
  });

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

  app.openapi(checkout, (c) =>
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

  // @ts-expect-error `Legacy` has no handler
  matchErrors([CartNotFound, Legacy], {
    CartNotFound: () => rethrow(),
  });
}

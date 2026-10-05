// The docs/usage.md examples, inlined as type-level code so `test:types` catches doc drift.
// `pnpm check:docs` requires each usage.md ```ts block to appear here verbatim (after
// normalization). Setup and stubs sit before each block, never inside it. Blocks for external
// packages and runtime entry points are marked `<!-- doc-check: skip -->` in usage.md.
// Nothing here runs.
import { OpenAPIHono } from '@hono/zod-openapi';
import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { testClient } from 'hono/testing';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  createRouter,
  defineChildContext,
  defineChildRoute,
  defineRootContext,
  defineRootRoute,
  emptyResponse,
  extendRouteContext,
  handle,
  jsonRequest,
  jsonResponse,
  matchErrors,
  mountRouter,
  onError,
  rethrow,
} from './index';
import type {
  ContextEnv,
  ReaugmentContext,
  RouteContextBase,
  RouteContextKind,
  RouteMiddlewareFactory,
} from './index';
import { createScopeMiddleware } from './scopes';

// Type-only references keep the import count under the lint limit. `cors` and `honoLogger` are
// the middlewares of Hono, and `ParamKeys` is the type of `hono/types`.
declare const cors: typeof import('hono/cors').cors;

declare const honoLogger: typeof import('hono/logger').logger;

type ParamKeys<TPath extends string> = import('hono/types').ParamKeys<TPath>;

// The stubs of `./services` and of the reader's own code.
interface Session {
  userId: string;
  scopes: string[];
}

interface OrganizationRecord {
  id: string;
  name: string;
}

type ThingRecord = { id: string; name: string; ownerId: string };

const Department = z.object({ id: z.string(), name: z.string() });

interface Membership {
  role: 'owner' | 'member';
}

class ThingNotFound extends Error {
  readonly _tag = 'ThingNotFound' as const;
}

declare const verifySession: (header: string | undefined) => Promise<Session | null>;

declare const allowRequest: (key: string, limitPerMinute: number) => Promise<boolean>;

declare const findOrganization: (id: string, userId: string) => Promise<OrganizationRecord | null>;

declare const listThings: (organizationId: string) => Promise<ThingRecord[]>;

declare const createThing: (
  organizationId: string,
  ownerId: string,
  input: { name: string },
) => Promise<ThingRecord>;

/** Throws `ThingNotFound` when the thing does not exist. */
declare const findThing: (organizationId: string, id: string) => Promise<ThingRecord>;

declare const db: {
  organizations: {
    find: (id: string) => Promise<OrganizationRecord | null>;
  };
  departments: {
    listFor: (organizationId: string, userId?: string) => Promise<z.infer<typeof Department>[]>;
  };
  memberships: {
    find: (organizationId: string, userId: string) => Promise<Membership>;
  };
  things: {
    list: () => Promise<{ id: string; name: string }[]>;
    create: (input: { name: string }) => Promise<{ id: string; name: string }>;
    find: (id: string) => Promise<{ id: string; name: string } | null>;
    delete: (id: string) => Promise<void>;
  };
};

declare const readSession: (c: unknown) => Promise<Session>;

// usage.md "Complete example".
{
  interface RequestVars {
    requestId: string;
    log: (message: string) => void;
  }

  interface SessionVars {
    session: Session;
  }

  const ErrorBody = z.object({ error: z.string() });
  const Organization = z.object({ id: z.string(), name: z.string() });
  const Thing = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
  const CreateThing = z.object({ name: z.string().min(1) });

  const requireSession = createMiddleware<{ Variables: SessionVars }>(
    async function requireSession(c, next) {
      const session = await verifySession(c.req.header('authorization'));

      if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
      c.set('session', session);
      await next();
    },
  );

  const apiContext = defineRootContext('/api')
    .middleware<RequestVars>(async function trackRequest(c, next) {
      const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
      c.set('requestId', requestId);
      c.set('log', (message) => console.info(JSON.stringify({ requestId, message })));
      c.header('X-Request-Id', requestId);
      await next();
      c.var.log(`${c.req.method} ${c.req.path} -> ${c.res.status}`);
    })
    .middleware(requireSession);

  const organizationContext = defineChildContext(apiContext, '/organizations/:organizationId').bind(
    'organization',
    'organizationId',
    (id, c) => findOrganization(id, c.var.session.userId),
  );

  const thingsContext = defineChildContext(organizationContext, '/things');
  const thingByIdContext = defineChildContext(thingsContext, '/:id');

  const scopeMiddleware = createScopeMiddleware<SessionVars>({
    resolve: (c) => c.var.session.scopes,
  });

  const rateLimitMiddleware: RouteMiddlewareFactory = (route, meta) =>
    createMiddleware<{ Variables: SessionVars }>(async function rateLimit(c, next) {
      const key = `${c.var.session.userId}:${route.operationId ?? meta.path}`;
      const limitPerMinute = route.method === 'get' ? 120 : 20;

      if (!(await allowRequest(key, limitPerMinute))) {
        return c.json({ error: 'RATE_LIMITED' }, 429);
      }

      await next();
    });

  const makeRouter = createRouter({
    routeDefaults: {
      responses: {
        401: jsonResponse(ErrorBody, 'Unauthorized'),
        403: jsonResponse(ErrorBody, 'Forbidden'),
        404: jsonResponse(ErrorBody, 'Not found'),
        429: jsonResponse(ErrorBody, 'Too many requests'),
      },
    },
    transformRoute: (config, meta) => ({
      ...config,
      operationId:
        config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
    }),
    routeMiddleware: [scopeMiddleware, rateLimitMiddleware],
  });

  const thingNotFoundArms = matchErrors([ThingNotFound], {
    ThingNotFound: (_error, c) => c.json({ error: 'NOT_FOUND' }, 404),
  });

  const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const getThingRoute = defineRoute('get', {
      responses: { 200: jsonResponse(Thing, 'The thing') },
    });

    return app.openapi(getThingRoute, (c) =>
      handle(
        c,
        async ({ param }) => c.json(await findThing(c.var.organization.id, param.id), 200),
        thingNotFoundArms,
      ),
    );
  });

  const thingsRouter = makeRouter(
    thingsContext,
    ({ app, defineRoute }) => {
      const listThingsRoute = defineRoute('get', {
        responses: { 200: jsonResponse(z.array(Thing), 'The things of the organization') },
      });

      const createThingRoute = defineRoute('post', {
        request: jsonRequest(CreateThing, 'The new thing'),
        responses: { 201: jsonResponse(Thing, 'The created thing') },
        security: [{ bearer: ['things:write'] }],
      });

      return app
        .openapi(listThingsRoute, async (c) => c.json(await listThings(c.var.organization.id), 200))
        .openapi(createThingRoute, async (c) => {
          const { organization, session } = c.var;
          const thing = await createThing(organization.id, session.userId, c.req.valid('json'));
          c.var.log(`created thing ${thing.id}`);

          return c.json(thing, 201);
        });
    },
    [thingByIdRouter],
  );

  const organizationRouter = makeRouter(
    organizationContext,
    ({ app, defineRoute }) => {
      const getOrganizationRoute = defineRoute('get', {
        responses: { 200: jsonResponse(Organization, 'The organization') },
      });

      return app.openapi(getOrganizationRoute, (c) => c.json(c.var.organization, 200));
    },
    [thingsRouter],
  );

  const app = mountRouter(apiContext, [organizationRouter]);

  const server = new OpenAPIHono().route('/', app);

  server.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));
  server.doc('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Things API', version: '1.0.0' },
  });
  server.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
  });

  expectTypeOf<keyof typeof apiContext.vars>().toEqualTypeOf<'requestId' | 'log' | 'session'>();
  expectTypeOf(
    thingByIdContext.path,
  ).toEqualTypeOf<'/api/organizations/:organizationId/things/:id'>();
  expectTypeOf<keyof typeof thingByIdContext.vars>().toEqualTypeOf<
    'session' | 'requestId' | 'log' | 'organization'
  >();
  expectTypeOf(thingByIdContext.vars.organization).toEqualTypeOf<OrganizationRecord>();

  // `param` has the type of the context path.
  makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const getThingRoute = defineRoute('get', {
      responses: { 200: jsonResponse(Thing, 'The thing') },
    });

    return app.openapi(getThingRoute, (c) =>
      handle(c, async ({ param }) => {
        expectTypeOf(param).toEqualTypeOf<{ organizationId: string; id: string }>();

        return c.json(await findThing(c.var.organization.id, param.id), 200);
      }),
    );
  });

  // An arm with a status that the route does not declare is a compile error.
  makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const getThingRoute = defineRoute('get', {
      responses: { 200: jsonResponse(Thing, 'The thing') },
    });

    const arms = matchErrors([ThingNotFound], {
      ThingNotFound: (_error, c) => c.json({ error: 'NOT_FOUND' }, 410),
    });

    const thing: ThingRecord = { id: 'id', name: 'name', ownerId: 'owner' };

    // @ts-expect-error 410 is not a declared response
    return app.openapi(getThingRoute, (c) => handle(c, async () => c.json(thing, 200), arms));
  });

  // The client types of the complete example.
  const client = testClient(server);
  const headers = { authorization: 'Bearer test-token' };

  const readMissingThing = async () => {
    const res = await client.api.organizations[':organizationId'].things[':id'].$get(
      { param: { organizationId: 'org-1', id: 'missing' } },
      { headers },
    );

    expectTypeOf(res.status).toEqualTypeOf<200 | 401 | 403 | 404 | 429>();

    if (res.status === 404) {
      expectTypeOf(await res.json()).toEqualTypeOf<{ error: string }>();
    }

    const created = await client.api.organizations[':organizationId'].things.$post(
      { param: { organizationId: 'org-1' }, json: { name: 'Widget' } },
      { headers },
    );

    if (created.status === 201) {
      expectTypeOf(await created.json()).toEqualTypeOf<ThingRecord>();
    }
  };

  expectTypeOf(readMissingThing).toBeFunction();
}

// usage.md "Project layout": each file of the tree, in one module. The files are ordered by
// their value imports. A `typeof` of a later context is a type-only reference, as in the files.

// src/api/schemas.ts
const ErrorBody = z.object({ error: z.string() });

const Organization = z.object({ id: z.string(), name: z.string() });

const Thing = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });

const CreateThing = z.object({ name: z.string().min(1) });

// src/api/middleware.ts
interface RequestVars {
  requestId: string;
  log: (message: string) => void;
}

interface SessionVars {
  session: Session;
}

const trackRequest = createMiddleware<{ Variables: RequestVars }>(
  async function trackRequest(c, next) {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('log', (message) => console.info(JSON.stringify({ requestId, message })));
    c.header('X-Request-Id', requestId);
    await next();
    c.var.log(`${c.req.method} ${c.req.path} -> ${c.res.status}`);
  },
);

const requireSession = createMiddleware<{ Variables: SessionVars }>(
  async function requireSession(c, next) {
    const session = await verifySession(c.req.header('authorization'));

    if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('session', session);
    await next();
  },
);

// src/api/router.ts
const scopeMiddleware = createScopeMiddleware<SessionVars>({
  resolve: (c) => c.var.session.scopes,
});

const rateLimitMiddleware: RouteMiddlewareFactory = (route, meta) =>
  createMiddleware<{ Variables: SessionVars }>(async function rateLimit(c, next) {
    const key = `${c.var.session.userId}:${route.operationId ?? meta.path}`;
    const limitPerMinute = route.method === 'get' ? 120 : 20;

    if (!(await allowRequest(key, limitPerMinute))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }

    await next();
  });

const makeRouter = createRouter({
  routeDefaults: {
    responses: {
      401: jsonResponse(ErrorBody, 'Unauthorized'),
      403: jsonResponse(ErrorBody, 'Forbidden'),
      404: jsonResponse(ErrorBody, 'Not found'),
      429: jsonResponse(ErrorBody, 'Too many requests'),
    },
  },
  transformRoute: (config, meta) => ({
    ...config,
    operationId:
      config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
  }),
  routeMiddleware: [scopeMiddleware, rateLimitMiddleware],
});

// src/api/organizations/[organizationId]/things/[id].ts
const thingByIdContext = defineChildContext<typeof thingsContext>()('/:id');

const thingNotFoundArms = matchErrors([ThingNotFound], {
  ThingNotFound: (_error, c) => c.json({ error: 'NOT_FOUND' }, 404),
});

const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
  const getThingRoute = defineRoute('get', {
    responses: { 200: jsonResponse(Thing, 'The thing') },
  });

  return app.openapi(getThingRoute, (c) =>
    handle(
      c,
      async ({ param }) => c.json(await findThing(c.var.organization.id, param.id), 200),
      thingNotFoundArms,
    ),
  );
});

// src/api/organizations/[organizationId]/things/index.ts
const thingsContext = defineChildContext<typeof organizationContext>()('/things');

const thingsRouter = makeRouter(
  thingsContext,
  ({ app, defineRoute }) => {
    const listThingsRoute = defineRoute('get', {
      responses: { 200: jsonResponse(z.array(Thing), 'The things of the organization') },
    });

    const createThingRoute = defineRoute('post', {
      request: jsonRequest(CreateThing, 'The new thing'),
      responses: { 201: jsonResponse(Thing, 'The created thing') },
      security: [{ bearer: ['things:write'] }],
    });

    return app
      .openapi(listThingsRoute, async (c) => c.json(await listThings(c.var.organization.id), 200))
      .openapi(createThingRoute, async (c) => {
        const { organization, session } = c.var;
        const thing = await createThing(organization.id, session.userId, c.req.valid('json'));
        c.var.log(`created thing ${thing.id}`);

        return c.json(thing, 201);
      });
  },
  [thingByIdRouter],
);

// src/api/organizations/[organizationId]/index.ts
const organizationContext = defineChildContext<typeof apiContext>()(
  '/organizations/:organizationId',
).bind('organization', 'organizationId', (id, c) => findOrganization(id, c.var.session.userId));

const organizationRouter = makeRouter(
  organizationContext,
  ({ app, defineRoute }) => {
    const getOrganizationRoute = defineRoute('get', {
      responses: { 200: jsonResponse(Organization, 'The organization') },
    });

    return app.openapi(getOrganizationRoute, (c) => c.json(c.var.organization, 200));
  },
  [thingsRouter],
);

// src/api/index.ts
const apiContext = defineRootContext('/api').middleware(trackRequest).middleware(requireSession);

const app = mountRouter(apiContext, [organizationRouter]);

const server = new OpenAPIHono().route('/', app);

server.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));

server.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Things API', version: '1.0.0' } });

server.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
  type: 'http',
  scheme: 'bearer',
});

expectTypeOf(
  thingByIdContext.path,
).toEqualTypeOf<'/api/organizations/:organizationId/things/:id'>();

expectTypeOf<keyof typeof thingByIdContext.vars>().toEqualTypeOf<
  'requestId' | 'log' | 'session' | 'organization'
>();

expectTypeOf(thingByIdContext.vars.organization).toEqualTypeOf<OrganizationRecord>();

// src/api/index.test.ts
{
  const client = testClient(server);
  const organization = client.api.organizations[':organizationId'];
  const param = { organizationId: 'org-1' };
  const reader = { headers: { authorization: 'Bearer reader-token' } };
  const writer = { headers: { authorization: 'Bearer writer-token' } };

  it('returns the organization of a member', async () => {
    const res = await organization.$get({ param }, reader);

    expect(res.status).toBe(200);
  });

  it('returns 401 without a token', async () => {
    const res = await organization.things.$get({ param });

    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns 403 when the session has no things:write scope', async () => {
    const res = await organization.things.$post({ param, json: { name: 'Widget' } }, reader);

    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown thing', async () => {
    const res = await organization.things[':id'].$get(
      { param: { ...param, id: 'missing' } },
      reader,
    );

    expect(res.status).toBe(404);

    if (res.status === 404) {
      expect(await res.json()).toEqual({ error: 'NOT_FOUND' });
    }
  });

  it('creates a thing', async () => {
    const res = await organization.things.$post({ param, json: { name: 'Widget' } }, writer);

    expect(res.status).toBe(201);

    if (res.status === 201) {
      expect((await res.json()).name).toBe('Widget');
    }
  });
}

// usage.md "Project layout": "Children".
{
  const statsRouter = makeRouter(defineChildContext(thingsContext, '/stats'), () => {});

  const thingsChildren = [statsRouter, thingByIdRouter] as const;

  const thingsRouter = makeRouter(thingsContext, () => {}, thingsChildren);

  expectTypeOf(
    testClient(thingsRouter()).api.organizations[':organizationId'].things[':id'].$get,
  ).toBeFunction();
}

// usage.md "A complete CRUD resource".
const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

{
  const Thing = z.object({ id: z.string(), name: z.string() });
  const CreateThing = z.object({ name: z.string().min(1) });

  const apiContext = defineRootContext('/api');
  const thingsContext = defineChildContext(apiContext, '/things');

  const thingByIdContext = defineChildContext(apiContext, '/things/:id').bind('thing', 'id', (id) =>
    db.things.find(id),
  );

  const makeRouter = createRouter();

  const thingsRouter = makeRouter(thingsContext, ({ app, defineRoute }) => {
    const listThingsRoute = defineRoute('get', {
      responses: { 200: jsonResponse(z.array(Thing), 'List of things') },
    });

    const createThingRoute = defineRoute('post', {
      request: jsonRequest(CreateThing, 'Create a thing'),
      responses: { 201: jsonResponse(Thing, 'Created') },
    });

    return app
      .openapi(listThingsRoute, async (c) => c.json(await db.things.list(), 200))
      .openapi(createThingRoute, async (c) =>
        c.json(await db.things.create(c.req.valid('json')), 201),
      );
  });

  const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const getThingRoute = defineRoute('get', {
      responses: {
        200: jsonResponse(Thing, 'A thing'),
        404: emptyResponse('Not found'),
      },
    });

    const deleteThingRoute = defineRoute('delete', {
      responses: { 204: emptyResponse('Deleted') },
    });

    return app
      .openapi(getThingRoute, (c) => c.json(c.var.thing, 200))
      .openapi(deleteThingRoute, async (c) => {
        await db.things.delete(c.var.thing.id);

        return c.body(null, 204);
      });
  });

  const app = mountRouter(apiContext, [thingsRouter, thingByIdRouter]);

  expectTypeOf(thingByIdContext.vars.thing).toEqualTypeOf<{ id: string; name: string }>();
  expectTypeOf(testClient(app).api.things[':id'].$delete).toBeFunction();

  // usage.md "Testing a router".
  {
    const app = mountRouter(apiContext, [thingsRouter, thingByIdRouter]);
    const client = testClient(app);

    it('creates a thing', async () => {
      const res = await client.api.things.$post({ json: { name: 'Widget' } });

      expect(res.status).toBe(201);

      if (res.status === 201) {
        const thing = await res.json();
        expect(thing.name).toBe('Widget');
      }
    });

    it('rejects an invalid body', async () => {
      // @ts-expect-error: `name` is required
      const res = await client.api.things.$post({ json: {} });

      expect(res.status).toBe(400);
    });

    it('reads a thing by id', async () => {
      const res = await client.api.things[':id'].$get({ param: { id: '42' } });

      expect([200, 404]).toContain(res.status);
    });

    const res = await app.request('/api/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(res.status).toBe(400);

    const byId = await client.api.things[':id'].$get({ param: { id: '42' } });

    expectTypeOf(byId.status).toEqualTypeOf<200 | 404>();
  }
}

// usage.md "Path params".
{
  const apiContext = defineRootContext('/api');
  const thingByIdContext = defineChildContext(apiContext, '/things/:id');
  const noteContext = defineChildContext(thingByIdContext, '/notes/:noteId?');

  const Note = z.object({ thingId: z.number(), noteId: z.string().optional() });

  const notesRouter = makeRouter(noteContext, ({ app, defineRoute }) => {
    const getNoteRoute = defineRoute('get', {
      request: { params: z.object({ id: z.coerce.number() }) },
      responses: { 200: jsonResponse(Note, 'The note') },
    });

    return app.openapi(getNoteRoute, (c) => {
      const { id } = c.req.valid('param');
      const noteId = c.req.param('noteId');

      return c.json({ thingId: id, noteId }, 200);
    });
  });

  expectTypeOf(notesRouter).toBeFunction();
}

// usage.md "Nesting children".
{
  const apiContext = defineRootContext('/api');
  const organizationContext = defineChildContext(apiContext, '/organizations/:organizationId');
  const departmentsContext = defineChildContext(organizationContext, '/departments');

  const departmentsRouter = makeRouter(departmentsContext, ({ app, defineRoute }) => {
    const listDepartmentsRoute = defineRoute('get', {
      responses: { 200: jsonResponse(z.array(Department), 'OK') },
    });

    return app.openapi(listDepartmentsRoute, async (c) =>
      c.json(await db.departments.listFor(c.req.param('organizationId')), 200),
    );
  });

  const organizationRouter = makeRouter(organizationContext, () => {}, [departmentsRouter]);
  const app = mountRouter(apiContext, [organizationRouter]);

  expectTypeOf(
    departmentsContext.path,
  ).toEqualTypeOf<'/api/organizations/:organizationId/departments'>();
  expectTypeOf(
    testClient(app).api.organizations[':organizationId'].departments.$get,
  ).toBeFunction();
}

// usage.md "Reusing context middleware across children".
{
  const apiContext = defineRootContext('/api').middleware(requireSession);

  const organizationContext = defineChildContext(apiContext, '/organizations/:organizationId').bind(
    'organization',
    'organizationId',
    (id) => db.organizations.find(id),
  );

  const departmentsRouter = makeRouter(
    defineChildContext(organizationContext, '/departments'),
    ({ app, defineRoute }) => {
      const listDepartmentsRoute = defineRoute('get', {
        responses: { 200: jsonResponse(z.array(Department), 'OK') },
      });

      return app.openapi(listDepartmentsRoute, async (c) => {
        const { organization, session } = c.var;

        return c.json(await db.departments.listFor(organization.id, session.userId), 200);
      });
    },
  );

  expectTypeOf(departmentsRouter).toBeFunction();
  expectTypeOf<keyof typeof organizationContext.vars>().toEqualTypeOf<'session' | 'organization'>();

  interface MembershipVars {
    membership: Membership;
  }

  const loadMembership = createMiddleware<ContextEnv<typeof organizationContext, MembershipVars>>(
    async function loadMembership(c, next) {
      c.set('membership', await db.memberships.find(c.var.organization.id, c.var.session.userId));
      await next();
    },
  );

  const departmentsContext = defineChildContext(organizationContext, '/departments').middleware(
    loadMembership,
  );

  expectTypeOf<keyof typeof departmentsContext.vars>().toEqualTypeOf<
    'session' | 'organization' | 'membership'
  >();

  // @ts-expect-error This middleware reads vars that the context does not have: organization, session
  defineRootContext('/public').middleware(loadMembership);

  // @ts-expect-error Cannot redeclare existing var: membership
  departmentsContext.middleware(loadMembership);
}

// usage.md "Middleware for every route with route middleware factories".
interface LogEntry {
  method: string;
  tags?: string[];
  status: number;
  ms: number;
}

declare const logger: { info: (entry: LogEntry) => void };

{
  const scopeMiddleware = createScopeMiddleware<SessionVars>({
    resolve: (c) => c.var.session.scopes,
  });

  const requestLogMiddleware: RouteMiddlewareFactory = (route) =>
    async function logRequest(c, next) {
      const start = Date.now();
      await next();
      logger.info({
        method: route.method,
        tags: route.tags,
        status: c.res.status,
        ms: Date.now() - start,
      });
    };

  const operationIdHeaderMiddleware: RouteMiddlewareFactory = (route) =>
    async function setOperationIdHeader(c, next) {
      await next();

      if (route.operationId) c.header('X-Operation-Id', route.operationId);
    };

  const makeRouter = createRouter({
    routeMiddleware: [scopeMiddleware, requestLogMiddleware, operationIdHeaderMiddleware],
  });

  expectTypeOf(makeRouter).toBeFunction();
}

// usage.md "Scope checks with `createScopeMiddleware`".
{
  const scopeMiddleware = createScopeMiddleware<SessionVars>({
    resolve: (c) => c.var.session.scopes,
    onForbidden: (missing, c) => ({ code: 'FORBIDDEN', missing, userId: c.var.session.userId }),
  });

  const makeRouter = createRouter({ routeMiddleware: scopeMiddleware });

  expectTypeOf(makeRouter).toBeFunction();

  const sessionContext = defineRootContext('/api').middleware<SessionVars>(
    async function loadSession(c, next) {
      c.set('session', await readSession(c));
      await next();
    },
  );

  const contextScopeMiddleware = createScopeMiddleware(sessionContext, {
    resolve: (c) => c.var.session.scopes,
  });

  expectTypeOf(contextScopeMiddleware).toEqualTypeOf<RouteMiddlewareFactory>();

  // Without a type argument or a context, `c.var` has no vars.
  // @ts-expect-error Property 'session' does not exist
  createScopeMiddleware({ resolve: (c) => c.var.session.scopes });

  createScopeMiddleware({
    resolve: () => [],
    // @ts-expect-error Property 'session' does not exist
    onForbidden: (missing, c) => ({ missing, userId: c.var.session.userId }),
  });

  // A route middleware factory is not a middleware.
  // @ts-expect-error `createScopeMiddleware` returns a route middleware factory
  defineRootContext('/scoped').middleware(scopeMiddleware);
}

// usage.md "Custom route middleware with `createMiddleware`".
{
  const auditLog = {
    write: async (_entry: { userId: string; operation: string; status: number }) => {},
  };

  interface SessionVars {
    session: { userId: string; scopes: string[] };
  }

  const auditMiddleware: RouteMiddlewareFactory = (route, meta) =>
    createMiddleware<{ Variables: SessionVars }>(async function audit(c, next) {
      await next();
      await auditLog.write({
        userId: c.var.session.userId,
        operation: route.operationId ?? `${route.method} ${meta.path}`,
        status: c.res.status,
      });
    });

  const makeRouter = createRouter({
    routeMiddleware: [
      createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes }),
      auditMiddleware,
    ],
  });

  expectTypeOf(makeRouter).toBeFunction();
}

// usage.md "Middleware for a single route".
declare const quotas: { remaining: (userId: string) => Promise<number> };

declare const uploads: {
  save: (body: { name: string }, quota: number) => Promise<{ id: string }>;
};

{
  interface UploadVars {
    uploadQuota: number;
  }

  const loadQuota = createMiddleware<ContextEnv<typeof apiContext, UploadVars>>(
    async function loadQuota(c, next) {
      c.set('uploadQuota', await quotas.remaining(c.var.session.userId));
      await next();
    },
  );

  const UploadBody = z.object({ name: z.string() });
  const Upload = z.object({ id: z.string() });

  const uploadsRouter = makeRouter(apiContext, ({ app, defineRoute }) => {
    const uploadFileRoute = defineRoute('post', {
      middleware: loadQuota,
      request: jsonRequest(UploadBody, 'The file'),
      responses: { 201: jsonResponse(Upload, 'Uploaded') },
    });

    return app.openapi(uploadFileRoute, async (c) =>
      c.json(await uploads.save(c.req.valid('json'), c.var.uploadQuota), 201),
    );
  });

  expectTypeOf(uploadsRouter).toBeFunction();

  makeRouter(apiContext, ({ app, defineRoute }) =>
    app.openapi(
      defineRoute('post', {
        middleware: loadQuota,
        request: jsonRequest(UploadBody, 'The file'),
        responses: { 201: jsonResponse(Upload, 'Uploaded') },
      }),
      async (c) => {
        expectTypeOf(c.var.uploadQuota).toEqualTypeOf<number>();
        expectTypeOf(c.var.session).toEqualTypeOf<Session>();

        return c.json({ id: 'id' }, 201);
      },
    ),
  );
}

// usage.md "Sharing `routeDefaults` across every route".
{
  const thingsContext = defineChildContext(defineRootContext('/api'), '/things');
  const Thing = z.object({ id: z.string(), name: z.string() });

  const Unauthorized = z.object({ error: z.literal('UNAUTHORIZED') });
  const Forbidden = z.object({ error: z.literal('FORBIDDEN') });
  const BaseValidation = z.object({ code: z.literal('BASE_INVALID'), issues: z.array(z.string()) });

  const makeRouter = createRouter({
    routeDefaults: {
      tags: ['v1'],
      responses: {
        401: jsonResponse(Unauthorized, 'Unauthorized'),
        403: jsonResponse(Forbidden, 'Forbidden'),
        422: jsonResponse(BaseValidation, 'Validation error (default)'),
      },
    },
  });

  const thingsRouter = makeRouter(thingsContext, ({ app, defineRoute }) => {
    const RouteValidation = z.object({ code: z.literal('NAME_TOO_LONG') });

    const createThingRoute = defineRoute('post', {
      tags: ['things'],
      request: jsonRequest(CreateThing, 'Create a thing'),
      responses: {
        201: jsonResponse(Thing, 'Created'),
        422: jsonResponse(RouteValidation, 'Validation error (route)'),
      },
    });

    return app.openapi(createThingRoute, async (c) =>
      c.json(await db.things.create(c.req.valid('json')), 201),
    );
  });

  expectTypeOf(thingsRouter).toBeFunction();

  makeRouter(thingsContext, ({ defineRoute }) => {
    const createThingRoute = defineRoute('post', {
      responses: { 201: jsonResponse(Thing, 'Created') },
    });

    expectTypeOf(createThingRoute.responses).toHaveProperty(401);
    expectTypeOf(createThingRoute.responses).toHaveProperty(403);
  });
}

// usage.md "Changing every route config with `transformRoute`".
{
  const makeRouter = createRouter({
    transformRoute: (config) => ({
      ...config,
      summary: config.summary ?? config.operationId,
      tags: [...new Set([...(config.tags ?? []), config.method === 'get' ? 'read' : 'write'])],
    }),
  });

  expectTypeOf(makeRouter).toBeFunction();
}

{
  const makeRouter = createRouter({
    transformRoute: (config, meta) => ({
      ...config,
      operationId:
        config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
    }),
  });

  expectTypeOf(makeRouter).toBeFunction();
}

// usage.md "Opting a route out of the default security".
{
  const makeRouter = createRouter({
    routeDefaults: { security: [{ bearer: ['things:read'] }] },
    routeMiddleware: createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes }),
  });

  const apiRouter = makeRouter(apiContext, ({ app, defineRoute }) => {
    const getHealthRoute = defineRoute('get', { security: [], responses: { 200: okResponse } });
    const listThingsRoute = defineRoute('get', { responses: { 200: okResponse } });

    return app
      .openapi(getHealthRoute, (c) => c.json({ ok: true }, 200))
      .openapi(listThingsRoute, (c) => c.json({ ok: true }, 200));
  });

  expectTypeOf(apiRouter).toBeFunction();

  makeRouter(apiContext, ({ defineRoute }) => {
    const getHealthRoute = defineRoute('get', { security: [], responses: { 200: okResponse } });

    expectTypeOf(getHealthRoute.security).toEqualTypeOf<[]>();
  });
}

{
  const makeAuthedRouter = createRouter({ routeMiddleware: scopeMiddleware });
  const makePublicRouter = createRouter();

  const healthRouter = makePublicRouter(
    defineChildContext(apiContext, '/health'),
    ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
  );

  const thingsRouter = makeAuthedRouter(
    defineChildContext(apiContext, '/things'),
    ({ app, defineRoute }) =>
      app.openapi(
        defineRoute('get', {
          security: [{ bearer: ['things:read'] }],
          responses: { 200: okResponse },
        }),
        (c) => c.json({ ok: true }, 200),
      ),
  );

  const app = mountRouter(apiContext, [healthRouter, thingsRouter]);

  expectTypeOf(testClient(app).api.health.$get).toBeFunction();
  expectTypeOf(testClient(app).api.things.$get).toBeFunction();
}

// usage.md "Custom error bodies from middleware".
interface Limiter {
  check: (key: string) => Promise<{ allowed: boolean; retryAfter: number }>;
}

declare const globalLimiter: Limiter;

{
  const rateLimitMiddleware =
    (limiter: Limiter): RouteMiddlewareFactory =>
    () =>
      async function rateLimit(c, next) {
        const verdict = await limiter.check(c.req.header('x-api-key') ?? '');

        if (!verdict.allowed) {
          return c.json({ error: 'RATE_LIMITED', retryAfterSeconds: verdict.retryAfter }, 429, {
            'Retry-After': String(verdict.retryAfter),
          });
        }

        await next();
      };

  const makeRouter = createRouter({
    routeMiddleware: [rateLimitMiddleware(globalLimiter)],
  });

  expectTypeOf(makeRouter).toBeFunction();
}

// usage.md "Type-safe error handling in handlers".
declare const thingsRepo: {
  findOrFail: (id: string) => Promise<ThingRecord>;
  update: (id: string, input: { name: string }) => Promise<ThingRecord>;
};

declare class RecordNotFoundError extends Error {}

declare class UniqueConstraintError extends Error {
  columns: string[];
}

{
  const makeRouter = createRouter();
  const thingByIdContext = defineChildContext(defineRootContext('/api'), '/things/:id');

  class ThingNotFound extends Error {
    readonly _tag = 'ThingNotFound' as const;
  }

  class SlugTaken extends Error {
    readonly _tag = 'SlugTaken' as const;
    constructor(readonly slug: string) {
      super();
    }
  }

  const MessageBody = z.object({ message: z.string() });

  const thingArms = matchErrors([ThingNotFound, SlugTaken], {
    ThingNotFound: (_error, c) => c.json({ message: 'Thing not found' }, 404),
    SlugTaken: (error, c) => c.json({ message: `Slug already taken: ${error.slug}` }, 409),
  });

  const getThingRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const getThingRoute = defineRoute('get', {
      responses: {
        200: jsonResponse(Thing, 'The thing'),
        404: jsonResponse(MessageBody, 'Not found'),
        409: jsonResponse(MessageBody, 'Conflict'),
      },
    });

    return app.openapi(getThingRoute, (c) =>
      handle(
        c,
        async ({ param: { id } }) => c.json(await thingsRepo.findOrFail(id), 200),
        thingArms,
      ),
    );
  });

  expectTypeOf(getThingRouter).toBeFunction();

  const recordNotFoundArm = (message: string) =>
    onError(RecordNotFoundError, (_err, c) => c.json({ message }, 404));

  const updateThingRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const updateThingRoute = defineRoute('put', {
      request: jsonRequest(CreateThing, 'The new name'),
      responses: {
        200: jsonResponse(Thing, 'The thing'),
        404: jsonResponse(MessageBody, 'Not found'),
        409: jsonResponse(MessageBody, 'Conflict'),
      },
    });

    return app.openapi(updateThingRoute, (c) =>
      handle(c, async ({ param: { id }, json }) => c.json(await thingsRepo.update(id, json), 200), [
        ...matchErrors([SlugTaken], {
          SlugTaken: (e, ec) => ec.json({ message: `Slug already taken: ${e.slug}` }, 409),
        }),
        onError(UniqueConstraintError, (err, ec) => {
          if (!err.columns.includes('slug')) return rethrow();

          return ec.json({ message: 'Slug already taken' }, 409);
        }),
        recordNotFoundArm('Thing not found'),
      ]),
    );
  });

  expectTypeOf(updateThingRouter).toBeFunction();

  // Without `404` in `responses`, the handler is a compile error.
  makeRouter(thingByIdContext, ({ app, defineRoute }) => {
    const getThingRoute = defineRoute('get', {
      responses: {
        200: jsonResponse(Thing, 'The thing'),
        409: jsonResponse(MessageBody, 'Conflict'),
      },
    });

    return app.openapi(getThingRoute, (c) =>
      // @ts-expect-error 404 is not a declared response
      handle(
        c,
        async ({ param: { id } }) => c.json(await thingsRepo.findOrFail(id), 200),
        thingArms,
      ),
    );
  });

  // The handler map is exhaustive.
  // @ts-expect-error `SlugTaken` has no handler
  matchErrors([ThingNotFound, SlugTaken], {
    ThingNotFound: () => rethrow(),
  });
}

// usage.md "Adding custom builders with `extendRouteContext`".
type RelationsFor<TRepo> = { repository: TRepo; id: string };

declare const relationsFor: <TRepo>(repository: TRepo, id: string) => RelationsFor<TRepo>;

declare const organizationsRepository: { findById: (id: string) => Promise<unknown> };

declare const teamsRepository: { findById: (id: string) => Promise<unknown> };

declare const findMembership: (
  organization: RelationsFor<typeof organizationsRepository>,
  team: RelationsFor<typeof teamsRepository>,
) => Promise<Membership>;

{
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

  const { defineRootContext, defineChildContext } = extendRouteContext<CtxKind>({
    bindRepository: (context) => (key, param, repository) => {
      const mw: MiddlewareHandler = async (c, next) => {
        c.set(key, relationsFor(repository(), c.req.param(param)));
        await next();
      };

      return context.middleware(mw);
    },
  });

  const organizationContext = defineChildContext(
    apiContext,
    '/organizations/:organizationId',
  ).bindRepository('organization', 'organizationId', () => organizationsRepository);

  expectTypeOf(organizationContext.path).toEqualTypeOf<'/api/organizations/:organizationId'>();
  expectTypeOf(organizationContext.vars.organization).toEqualTypeOf<
    RelationsFor<typeof organizationsRepository>
  >();
  expectTypeOf(organizationContext.bindRepository).toBeFunction();
  expectTypeOf(defineRootContext('/ext').bindRepository).toBeFunction();

  const teamContext = defineChildContext(apiContext, '/organizations/:organizationId/teams/:teamId')
    .bindRepository('organization', 'organizationId', () => organizationsRepository)
    .bindRepository('team', 'teamId', () => teamsRepository)
    .middleware<{ membership: Membership }>(async function loadMembership(c, next) {
      c.set('membership', await findMembership(c.var.organization, c.var.team));
      await next();
    });

  expectTypeOf(teamContext.vars.team).toEqualTypeOf<RelationsFor<typeof teamsRepository>>();
  expectTypeOf(teamContext.vars.membership).toEqualTypeOf<Membership>();
  expectTypeOf(teamContext.bindRepository).toBeFunction();

  // @ts-expect-error a second bind with the same key is a compile error
  organizationContext.bindRepository('organization', 'organizationId', () => teamsRepository);

  // @ts-expect-error `param` must be a parameter of the context's path
  organizationContext.bindRepository('team', 'userId', () => teamsRepository);
}

// usage.md "Composing with regular Hono middleware".
{
  const logger = honoLogger;

  const server = new OpenAPIHono()
    .use('*', logger())
    .use('/api/*', cors({ origin: 'https://example.com' }))
    .route('/', app);

  expectTypeOf(testClient(server).api.organizations[':organizationId'].$get).toBeFunction();
}

// usage.md "Observability".
{
  const makeRouter = createRouter({
    routeMiddleware: (route) =>
      async function auditLog(c, next) {
        await next();
        console.info(route.method, c.res.status);
      },
  });

  expectTypeOf(makeRouter).toBeFunction();
}

// usage.md "Migrating from 0.x": the deprecated names are the same functions.
{
  const apiContext = defineRootRoute('/api');
  const thingsContext = defineChildRoute(apiContext, '/things');

  expectTypeOf(defineRootRoute).toEqualTypeOf(defineRootContext);
  expectTypeOf(defineChildRoute).toEqualTypeOf(defineChildContext);
  expectTypeOf(thingsContext.path).toEqualTypeOf<'/api/things'>();
}

// usage.md "Cloudflare bindings": the bindings of the root context type `c.env` in a handler.
{
  interface D1Database {
    prepare: (query: string) => { first: <T>(column: string) => Promise<T | null> };
  }

  const makeRouter = createRouter();

  interface Env {
    Bindings: { DB: D1Database };
  }

  const workerContext = defineRootContext<'/api', {}, Env['Bindings']>('/api');
  const statsResponse = jsonResponse(z.object({ users: z.number() }), 'User count');

  const statsRouter = makeRouter(
    defineChildContext(workerContext, '/stats'),
    ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: statsResponse } }), async (c) => {
        const users = await c.env.DB.prepare('SELECT count(*) AS n FROM users').first<number>('n');

        return c.json({ users: users ?? 0 }, 200);
      }),
  );

  const app = mountRouter(workerContext, [statsRouter]);

  expectTypeOf(workerContext.bindings.DB).toEqualTypeOf<D1Database>();
  expectTypeOf(app.fetch).toBeFunction();
}

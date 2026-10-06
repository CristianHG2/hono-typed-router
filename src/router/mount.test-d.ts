import type { OpenAPIHono } from '@hono/zod-openapi';
import { expectTypeOf } from 'expect-type';
import { testClient } from 'hono/testing';
import { z } from 'zod';
import { defineChildContext, defineRootContext } from '../definitions';
import { jsonRequest, jsonResponse } from '../schema-helpers';
import { createRouter } from './create-router';
import { mountRouter } from './mount';
import type { ChildRouter } from './types';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

// The route schemas of children go into the type of the parent, so `testClient` sees them
{
  const thing = z.object({ id: z.string(), name: z.string() });
  const notFound = z.object({ message: z.string() });

  const root = defineRootContext('/api', []);
  const thingsRoute = defineChildContext(root, '/things');
  const thingRoute = defineChildContext(thingsRoute, '/:id');
  const notesRoute = defineChildContext(thingRoute, '/notes');

  const makeRouter = createRouter();

  const notes = makeRouter(notesRoute, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const things = makeRouter(thingsRoute, ({ app, defineRoute }) =>
    app.openapi(
      defineRoute('post', {
        request: jsonRequest(z.object({ name: z.string() }), 'New thing'),
        responses: { 200: jsonResponse(thing, 'Created') },
      }),
      (c) => c.json({ id: '1', name: c.req.valid('json').name }, 200),
    ),
  );

  const thingById = makeRouter(
    thingRoute,
    ({ app, defineRoute }) =>
      app.openapi(
        defineRoute('get', {
          request: { params: z.object({ id: z.string() }) },
          responses: { 200: jsonResponse(thing, 'Found'), 404: jsonResponse(notFound, 'Missing') },
        }),
        (c) => c.json({ id: c.req.valid('param').id, name: 'x' }, 200),
      ),
    [notes],
  );

  const app = makeRouter(root, ({ app }) => app, [things, thingById])();
  const client = testClient(app);

  const getThing = client.api.things[':id'].$get;

  type GetResponse = Awaited<ReturnType<typeof getThing>>;

  expectTypeOf<Parameters<typeof getThing>[0]>().toEqualTypeOf<{
    param: { id: string };
  }>();
  expectTypeOf<GetResponse['status']>().toEqualTypeOf<200 | 404>();
  expectTypeOf<Awaited<ReturnType<Extract<GetResponse, { status: 200 }>['json']>>>().toEqualTypeOf<{
    id: string;
    name: string;
  }>();
  expectTypeOf<Awaited<ReturnType<Extract<GetResponse, { status: 404 }>['json']>>>().toEqualTypeOf<{
    message: string;
  }>();

  expectTypeOf<Parameters<(typeof client)['api']['things']['$post']>[0]>().toEqualTypeOf<{
    json: { name: string };
  }>();
  // @ts-expect-error `param.id` is required
  void client.api.things[':id'].$get({});
  // @ts-expect-error `json.name` is required
  void client.api.things.$post({ json: {} });

  const getNotes = client.api.things[':id'].notes.$get;
  expectTypeOf<Awaited<ReturnType<Awaited<ReturnType<typeof getNotes>>['json']>>>().toEqualTypeOf<{
    ok: boolean;
  }>();

  const voidApp = makeRouter(root, () => {}, [things])();
  expectTypeOf<
    Parameters<ReturnType<typeof testClient<typeof voidApp>>['api']['things']['$post']>[0]
  >().toEqualTypeOf<{ json: { name: string } }>();

  const withOwn = makeRouter(
    root,
    ({ app, defineRoute }) =>
      app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
        c.json({ ok: true }, 200),
      ),
    [things],
  )();

  type WithOwnClient = ReturnType<typeof testClient<typeof withOwn>>;

  expectTypeOf<WithOwnClient['api']['$get']>().toBeFunction();
  expectTypeOf<WithOwnClient['api']['things']['$post']>().toBeFunction();

  const curried = makeRouter(
    defineChildContext<typeof root>()('/curried/:slug'),
    ({ app, defineRoute }) =>
      app.openapi(
        defineRoute('get', {
          request: { params: z.object({ slug: z.string() }) },
          responses: { 200: okResponse },
        }),
        (c) => c.json({ ok: true }, 200),
      ),
  );

  const curriedApp = makeRouter(root, ({ app }) => app, [curried])();
  const getCurried = testClient(curriedApp).api.curried[':slug'].$get;

  expectTypeOf<Parameters<typeof getCurried>[0]>().toEqualTypeOf<{ param: { slug: string } }>();

  const kids: (() => OpenAPIHono<any, any, any>)[] = [things, thingById];
  const loose = makeRouter(root, ({ app }) => app, kids)();
  expectTypeOf(loose).toEqualTypeOf<OpenAPIHono<{ Variables: {} }>>();
}

// A value-form child of a root `'/'` is keyed at `/things`, not `//things`.
{
  const root = defineRootContext('/', []);
  const makeRouter = createRouter();

  const things = makeRouter(defineChildContext(root, '/things'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, ({ app }) => app, [things])();

  type AppClient = ReturnType<typeof testClient<typeof app>>;

  expectTypeOf<AppClient['things']['$get']>().toBeFunction();
  expectTypeOf<keyof AppClient>().toEqualTypeOf<'things'>();
}

// A child segment without a leading `/` is keyed at `/api/x`, where Hono mounts it.
{
  const root = defineRootContext('/api', []);
  const makeRouter = createRouter();

  const x = makeRouter(defineChildContext(root, 'x'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, ({ app }) => app, [x])();

  type AppClient = ReturnType<typeof testClient<typeof app>>;

  expectTypeOf<keyof AppClient>().toEqualTypeOf<'api'>();
  expectTypeOf<keyof AppClient['api']>().toEqualTypeOf<'x'>();
  expectTypeOf<AppClient['api']['x']['$get']>().toBeFunction();
}

// A `makeRouter(...)` call nested inline in `children` keeps the route of the grandchild
{
  const root = defineRootContext('/api', []);
  const things = defineChildContext(root, '/things');
  const thingById = defineChildContext(things, '/:id');
  const makeRouter = createRouter();

  const thingByIdRouter = makeRouter(thingById, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  type SchemaKeys<T> = T extends () => OpenAPIHono<any, infer S, any> ? keyof S : never;

  const voidNested = makeRouter(root, () => {}, [makeRouter(things, () => {}, [thingByIdRouter])]);

  expectTypeOf<SchemaKeys<typeof voidNested>>().toEqualTypeOf<'/api/things/:id'>();

  const routerNested = makeRouter(root, ({ app }) => app, [
    makeRouter(things, ({ app }) => app, [thingByIdRouter]),
  ]);

  expectTypeOf<SchemaKeys<typeof routerNested>>().toEqualTypeOf<'/api/things/:id'>();

  const withOwn = makeRouter(root, ({ app }) => app, [
    makeRouter(
      things,
      ({ app, defineRoute }) =>
        app.openapi(defineRoute('post', { responses: { 200: okResponse } }), (c) =>
          c.json({ ok: true }, 200),
        ),
      [thingByIdRouter],
    ),
  ]);

  expectTypeOf<SchemaKeys<typeof withOwn>>().toEqualTypeOf<'/api/things' | '/api/things/:id'>();
  expectTypeOf(testClient(withOwn()).api.things[':id'].$get).toBeFunction();
}

// A child at the segment `'/'` is keyed at `'/api'`, not `'/api/'`
{
  const root = defineRootContext('/api', []);
  const makeRouter = createRouter();

  const child = makeRouter(defineChildContext(root, '/'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const app = makeRouter(root, () => {}, [child]);

  type SchemaKeys<T> = T extends () => OpenAPIHono<any, infer S, any> ? keyof S : never;

  expectTypeOf<SchemaKeys<typeof app>>().toEqualTypeOf<'/api'>();
  expectTypeOf(testClient(app()).api.$get).toBeFunction();
}

// The children signature gives the same types for each form of `children`.
{
  const root = defineRootContext('/api', []);
  const makeRouter = createRouter();

  const child = makeRouter(defineChildContext(root, '/x'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  type Plain = () => OpenAPIHono<{ Variables: {} }>;

  type SchemaKeys<T> = T extends () => OpenAPIHono<any, infer S, any> ? keyof S : never;

  function viaRouter({ app }: { app: OpenAPIHono<{ Variables: {} }> }) {
    return app;
  }

  expectTypeOf(makeRouter(root, () => {})).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, () => {}, [])).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, () => {}, undefined)).toEqualTypeOf<Plain>();
  // @ts-expect-error without children, a callback that returns an app with no routes is an error
  makeRouter(root, viaRouter);
  expectTypeOf(makeRouter(root, viaRouter, [])).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, viaRouter, undefined)).toEqualTypeOf<Plain>();

  const tuple = makeRouter(root, () => {}, [child]);
  expectTypeOf<SchemaKeys<typeof tuple>>().toEqualTypeOf<'/api/x'>();
  expectTypeOf(tuple).toEqualTypeOf(makeRouter(root, viaRouter, [child]));

  // With explicit type arguments, the children tuple type is the fourth type argument.
  expectTypeOf(makeRouter<'/api', {}, void, []>(root, () => {}, [])).toEqualTypeOf<Plain>();
  // @ts-expect-error TS2554: three explicit type arguments select the overload without children
  makeRouter<'/api', {}, void>(root, () => {}, []);

  const kids: (() => OpenAPIHono<any, any, any>)[] = [child];
  expectTypeOf(makeRouter(root, () => {}, kids)).toEqualTypeOf<Plain>();
  expectTypeOf(makeRouter(root, viaRouter, kids)).toEqualTypeOf<Plain>();
}

// `mountRouter` has the type of `makeRouter(context, ({ app }) => app, children)()`
{
  const thing = z.object({ id: z.string(), name: z.string() });

  const root = defineRootContext('/api', []).middleware<{ userId: string }>(async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });

  const things = defineChildContext(root, '/things');
  const thingById = defineChildContext(things, '/:id');
  const makeRouter = createRouter();

  const thingsRouter = makeRouter(things, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const byIdRouter = makeRouter(thingById, ({ app, defineRoute }) =>
    app.openapi(
      defineRoute('get', {
        request: { params: z.object({ id: z.string() }) },
        responses: { 200: jsonResponse(thing, 'Found') },
      }),
      (c) => c.json({ id: c.req.valid('param').id, name: c.var.userId }, 200),
    ),
  );

  const app = mountRouter(root, [thingsRouter, byIdRouter]);

  expectTypeOf(app).toEqualTypeOf(makeRouter(root, ({ app }) => app, [thingsRouter, byIdRouter])());

  expectTypeOf(app).toExtend<OpenAPIHono<any, any, any>>();
  // @ts-expect-error the app is not a `ChildRouter`
  makeRouter(root, () => {}, [app]);

  type AppEnv = typeof app extends OpenAPIHono<infer E, any, any> ? E : never;

  expectTypeOf<AppEnv>().toEqualTypeOf<{ Variables: { userId: string } }>();

  type SchemaKeys<T> = T extends OpenAPIHono<any, infer S, any> ? keyof S : never;

  expectTypeOf<SchemaKeys<typeof app>>().toEqualTypeOf<'/api/things' | '/api/things/:id'>();

  const getThing = testClient(app).api.things[':id'].$get;

  type GetResponse = Awaited<ReturnType<typeof getThing>>;

  expectTypeOf<Parameters<typeof getThing>[0]>().toEqualTypeOf<{ param: { id: string } }>();
  expectTypeOf<Awaited<ReturnType<GetResponse['json']>>>().toEqualTypeOf<{
    id: string;
    name: string;
  }>();

  const nested = mountRouter(root, [makeRouter(things, ({ app }) => app, [byIdRouter])]);

  expectTypeOf<SchemaKeys<typeof nested>>().toEqualTypeOf<'/api/things/:id'>();
  expectTypeOf(nested).toEqualTypeOf(
    makeRouter(root, ({ app }) => app, [makeRouter(things, ({ app }) => app, [byIdRouter])])(),
  );
  expectTypeOf(testClient(nested).api.things[':id'].$get).toBeFunction();

  type Plain = OpenAPIHono<{ Variables: { userId: string } }>;

  expectTypeOf(mountRouter(root, [])).toEqualTypeOf<Plain>();

  const kids: (() => OpenAPIHono<any, any, any>)[] = [thingsRouter];
  expectTypeOf(mountRouter(root, kids)).toEqualTypeOf<Plain>();

  // @ts-expect-error TS2554: expected 2 arguments
  mountRouter(root);
}

// A children array variable with one typed element type is an error
{
  const root = defineRootContext('/api', []);
  const things = defineChildContext(root, '/things');
  const makeRouter = createRouter();

  const statsRouter = makeRouter(things, ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  const byIdRouter = makeRouter(defineChildContext(things, '/:id'), ({ app, defineRoute }) =>
    app.openapi(defineRoute('delete', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
  );

  // The two children become one element type, so the routes of one child are lost.
  const plain = [statsRouter, byIdRouter];

  // @ts-expect-error Pass children inline or as const
  mountRouter(root, plain);
  // @ts-expect-error Pass children inline or as const
  makeRouter(root, () => {}, plain);

  // Inline, `as const`, and `ChildRouter[]` (the opt-out) are accepted.
  mountRouter(root, [statsRouter, byIdRouter]);
  const tuple = [statsRouter, byIdRouter] as const;

  mountRouter(root, tuple);

  const optOut: ChildRouter[] = [statsRouter, byIdRouter];

  expectTypeOf(mountRouter(root, optOut)).toEqualTypeOf<OpenAPIHono<{ Variables: {} }>>();

  const union: (typeof statsRouter | typeof byIdRouter)[] = [statsRouter, byIdRouter];
  const app = mountRouter(root, union);

  expectTypeOf(testClient(app).api.things.$get).toBeFunction();
  expectTypeOf(testClient(app).api.things[':id'].$delete).toBeFunction();
}

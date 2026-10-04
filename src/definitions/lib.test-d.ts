import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ParamKeys } from 'hono/types';
import { createRouter } from '../router';
import { defineChildRoute, defineRootRoute } from './lib';
import type { ChildRouteFn, ContextEnv, RouteContext } from './types';

// Root context preserves the literal path type
{
  const ctx = defineRootRoute('/api', []);
  expectTypeOf(ctx).toMatchTypeOf<RouteContext<'/api', {}>>();
  expectTypeOf(ctx.path).toEqualTypeOf<'/api'>();
}

// `middleware()` adds vars to the context
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(async (_c, next) => {
    await next();
  });

  expectTypeOf(ctx).toMatchTypeOf<RouteContext<'/api', { user: { id: string } }>>();
  expectTypeOf(ctx.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `middleware()` rejects redeclaration of existing vars
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error — redeclaring `user` fails the `NoRedeclare` constraint on the type argument
  ctx.middleware<{
    user: { id: number };
  }>(async (c, next) => {
    // Contextual typing survives the guard: `c` is not an implicit `any`.
    expectTypeOf(c.var.user).toEqualTypeOf<{ id: string } & { id: number }>();
    await next();
  });
}

// Root vars default to `{}`, so a single middleware's vars display exactly
{
  const ctx = defineRootRoute('/api', []).middleware<{ session: { userId: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  expectTypeOf(ctx.vars).toEqualTypeOf<{ session: { userId: string } }>();
}

// `middleware()` without a type argument adds no vars (`TNewVars` defaults to `{}`)
{
  const root = defineRootRoute('/api', []);

  const ctx = root.middleware(async (_c, next) => {
    await next();
  });

  expectTypeOf(ctx.vars).toEqualTypeOf<typeof root.vars>();
  expectTypeOf<keyof typeof ctx.vars>().toEqualTypeOf<never>();

  // A handler typed up front still contributes its vars without a type argument.
  const typed: MiddlewareHandler<{ Variables: { z: boolean } }> = async (_c, next) => {
    await next();
  };

  expectTypeOf(root.middleware(typed).vars).toMatchTypeOf<{ z: boolean }>();
}

// `middleware<{ a: string }>()` types `c.var.a` in later middleware and in route handlers
{
  const ctx = defineRootRoute('/api', [])
    .middleware<{ a: string }>(async (c, next) => {
      c.set('a', 'x');
      await next();
    })
    .middleware<{ b: number }>(async (c, next) => {
      expectTypeOf(c.var.a).toEqualTypeOf<string>();
      await next();
    });

  expectTypeOf<keyof typeof ctx.vars>().toEqualTypeOf<'a' | 'b'>();

  createRouter()(ctx, ({ router }) => {
    router.use(async (c, next) => {
      expectTypeOf(c.var.a).toEqualTypeOf<string>();
      expectTypeOf(c.var.b).toEqualTypeOf<number>();
      await next();
    });

    return router;
  });
}

// `defineChildRoute` concatenates the parent path with the child path
{
  const parent = defineRootRoute('/api', []);
  const child = defineChildRoute<typeof parent>()('/things');
  expectTypeOf(child.path).toEqualTypeOf<'/api/things'>();

  const grandchild = defineChildRoute<typeof child>()('/:id');
  expectTypeOf(grandchild.path).toEqualTypeOf<'/api/things/:id'>();
}

// Child routes inherit the parent's vars
{
  const parent = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const child = defineChildRoute<typeof parent>()('/things');
  expectTypeOf(child.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `defineChildRoute` requires a parent with both `path` and `vars`
{
  // @ts-expect-error — `{ path: '/a' }` has no `vars`, so it fails the `ParentContext` constraint
  defineChildRoute<{ path: '/a' }>();

  // Any `{ path; vars }` shape works as a parent, not only a `RouteContext`.
  const child = defineChildRoute<{ path: '/a'; vars: { v: 1 } }>()('/b');
  expectTypeOf(child.path).toEqualTypeOf<'/a/b'>();
  expectTypeOf(child.vars).toEqualTypeOf<{ v: 1 }>();
}

// Value form: `defineChildRoute(parent, path)` infers the parent's path and vars
{
  const root = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const things = defineChildRoute(root, '/things');
  expectTypeOf(things.path).toEqualTypeOf<'/api/things'>();
  expectTypeOf(things.vars).toEqualTypeOf<{ user: { id: string } }>();

  const thing = defineChildRoute(things, '/:id');
  expectTypeOf(thing.path).toEqualTypeOf<'/api/things/:id'>();
  expectTypeOf(thing.vars).toEqualTypeOf<{ user: { id: string } }>();

  // A `.middleware()` parent passes its added vars down.
  const org = defineChildRoute(root, '/orgs/:orgId').middleware<{ org: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const depts = defineChildRoute(org, '/departments');
  expectTypeOf(depts.path).toEqualTypeOf<'/api/orgs/:orgId/departments'>();
  expectTypeOf(depts.vars).toEqualTypeOf<{ user: { id: string } } & { org: { id: string } }>();

  // The curried form still compiles and agrees with the value form.
  const curried = defineChildRoute<typeof root>()('/things');
  expectTypeOf(curried.path).toEqualTypeOf<typeof things.path>();
  expectTypeOf(curried.vars).toEqualTypeOf<typeof things.vars>();

  // A non-literal segment widens to a template type, as in the curried form.
  const dynamic = '/x' as string;
  expectTypeOf(defineChildRoute(root, dynamic).path).toEqualTypeOf<`/api${string}`>();

  // @ts-expect-error — the parent needs `vars`
  defineChildRoute({ path: '/a' }, '/b');
}

// A root `'/'` (or `''`) parent does not double the slash, in either form.
{
  const slashRoot = defineRootRoute('/', []);
  expectTypeOf(defineChildRoute(slashRoot, '/things').path).toEqualTypeOf<'/things'>();
  expectTypeOf(defineChildRoute<typeof slashRoot>()('/things').path).toEqualTypeOf<'/things'>();
  expectTypeOf(
    defineChildRoute(defineChildRoute(slashRoot, '/things'), '/:id').path,
  ).toEqualTypeOf<'/things/:id'>();

  const emptyRoot = defineRootRoute('', []);
  expectTypeOf(defineChildRoute(emptyRoot, '/things').path).toEqualTypeOf<'/things'>();

  // A trailing slash is dropped only when the segment brings its own.
  expectTypeOf(defineChildRoute(defineRootRoute('/api/', []), '/x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildRoute(slashRoot, 'things').path).toEqualTypeOf<'/things'>();
}

// A segment without a leading `/` is joined with one, in either form.
{
  const api = defineRootRoute('/api', []);
  expectTypeOf(defineChildRoute(api, 'x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildRoute<typeof api>()('x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildRoute(defineChildRoute(api, 'x'), 'y').path).toEqualTypeOf<'/api/x/y'>();
  expectTypeOf(defineChildRoute(defineRootRoute('', []), 'x').path).toEqualTypeOf<'/x'>();
  expectTypeOf(defineChildRoute(api, '').path).toEqualTypeOf<'/api'>();
}

// Value form nested inline as an argument of another generic call infers the full path,
// so a path-param-typed helper accepts the param name (as with a variable or the curried form).
{
  const bind = <P extends string>(ctx: RouteContext<P, {}>, param: NoInfer<ParamKeys<P>>) =>
    ctx.middleware<{ org: { id: string } }>(async (c, next) => {
      c.set('org', { id: c.req.param(param) ?? '' });
      await next();
    });

  const root = defineRootRoute('/api', []);

  const inline = bind(defineChildRoute(root, '/orgs/:orgId'), 'orgId');
  expectTypeOf(inline.path).toEqualTypeOf<'/api/orgs/:orgId'>();
  expectTypeOf(inline.vars).toEqualTypeOf<{ org: { id: string } }>();
  expectTypeOf(inline.middleware).toBeFunction();

  // Grandchild nested inline, and a `'/'` root.
  const deep = bind(defineChildRoute(defineChildRoute(root, '/orgs/:orgId'), '/teams'), 'orgId');
  expectTypeOf(deep.path).toEqualTypeOf<'/api/orgs/:orgId/teams'>();
  const slash = bind(defineChildRoute(defineRootRoute('/', []), '/orgs/:orgId'), 'orgId');
  expectTypeOf(slash.path).toEqualTypeOf<'/orgs/:orgId'>();

  // @ts-expect-error — 'nope' is not a param of '/api/orgs/:orgId'
  bind(defineChildRoute(root, '/orgs/:orgId'), 'nope');

  // The variable and curried forms keep working.
  const ctx = defineChildRoute(root, '/orgs/:orgId');
  expectTypeOf(bind(ctx, 'orgId').path).toEqualTypeOf<'/api/orgs/:orgId'>();
  expectTypeOf(
    bind(defineChildRoute<typeof root>()('/orgs/:orgId'), 'orgId').path,
  ).toEqualTypeOf<'/api/orgs/:orgId'>();

  // The curried overload still resolves to the public `ChildRouteFn` type.
  expectTypeOf(defineChildRoute<typeof root>()).toEqualTypeOf<ChildRouteFn<typeof root>>();
}

// `createMiddleware` from `hono/factory` passes to `.middleware()`. On a context without
// vars, an Env with only the new vars fits, and one middleware is reused on two contexts.
{
  type Session = { userId: string };

  const loadSession = createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    c.set('session', { userId: 'u1' });
    await next();
  });

  const api = defineRootRoute('/api', []).middleware<{ session: Session }>(loadSession);
  const admin = defineRootRoute('/admin/:org', []).middleware(loadSession);

  expectTypeOf(api.vars).toEqualTypeOf<{ session: Session }>();
  expectTypeOf(admin.vars).toEqualTypeOf<{ session: Session }>();
}

// On a context that already has vars, the Env must hold them too (Hono's `Context` matches
// `Variables` exactly). `ContextEnv<typeof ctx, NewVars>` builds that Env.
{
  type Session = { userId: string };

  const withRequestId = defineRootRoute('/api', []).middleware<{ requestId: string }>(
    async (c, next) => {
      c.set('requestId', 'r1');
      await next();
    },
  );

  expectTypeOf<ContextEnv<typeof withRequestId, { session: Session }>>().toEqualTypeOf<{
    Variables: { requestId: string } & { session: Session };
  }>();

  const loadSession = createMiddleware<ContextEnv<typeof withRequestId, { session: Session }>>(
    async (c, next) => {
      expectTypeOf(c.var.requestId).toEqualTypeOf<string>();
      c.set('session', { userId: c.var.requestId });
      await next();
    },
  );

  const authed = withRequestId.middleware<{ session: Session }>(loadSession);
  expectTypeOf<keyof typeof authed.vars>().toEqualTypeOf<'requestId' | 'session'>();

  // A child has the same vars as its parent, so the same middleware fits it.
  const child = defineChildRoute(withRequestId, '/things/:id').middleware(loadSession);
  expectTypeOf<keyof typeof child.vars>().toEqualTypeOf<'requestId' | 'session'>();

  // An Env with only the new vars does not fit a context that has other vars.
  const onlySession = createMiddleware<{ Variables: { session: Session } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error the Env lacks `requestId`, so `Context['set']` is not compatible
  withRequestId.middleware<{ session: Session }>(onlySession);
}

// Untyped `createMiddleware` results in `defineRootRoute(path, [a, b])` keep `vars` as `{}`
{
  const a = createMiddleware(async (_c, next) => {
    await next();
  });

  const b = createMiddleware(async (_c, next) => {
    await next();
  });

  expectTypeOf(defineRootRoute('/api', [a, b]).vars).toEqualTypeOf<{}>();
}

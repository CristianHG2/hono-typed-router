import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ParamKeys } from 'hono/types';
import { createRouter } from '../router';
import { defineChildContext, defineChildRoute, defineRootContext, defineRootRoute } from './lib';
import type { ChildRouteFn, ContextEnv, READS, RouteContext, SETS } from './types';

// Root context preserves the literal path type
{
  const ctx = defineRootContext('/api', []);
  expectTypeOf(ctx).toMatchTypeOf<RouteContext<'/api', {}>>();
  expectTypeOf(ctx.path).toEqualTypeOf<'/api'>();
}

// `middleware()` adds vars to the context
{
  const ctx = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  expectTypeOf(ctx).toMatchTypeOf<RouteContext<'/api', { user: { id: string } }>>();
  expectTypeOf(ctx.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `middleware()` rejects redeclaration of existing vars
{
  const ctx = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

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
  const ctx = defineRootContext('/api', []).middleware<{ session: { userId: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  expectTypeOf(ctx.vars).toEqualTypeOf<{ session: { userId: string } }>();
}

// `middleware()` without a type argument adds no vars (`TNewVars` defaults to `{}`)
{
  const root = defineRootContext('/api', []);

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
  const ctx = defineRootContext('/api', [])
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
  });
}

// `defineChildContext` concatenates the parent path with the child path
{
  const parent = defineRootContext('/api', []);
  const child = defineChildContext<typeof parent>()('/things');
  expectTypeOf(child.path).toEqualTypeOf<'/api/things'>();

  const grandchild = defineChildContext<typeof child>()('/:id');
  expectTypeOf(grandchild.path).toEqualTypeOf<'/api/things/:id'>();
}

// Child routes inherit the parent's vars
{
  const parent = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const child = defineChildContext<typeof parent>()('/things');
  expectTypeOf(child.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `defineChildContext` requires a parent with both `path` and `vars`
{
  // @ts-expect-error — `{ path: '/a' }` has no `vars`, so it fails the `ParentContext` constraint
  defineChildContext<{ path: '/a' }>();

  // Any `{ path; vars }` shape works as a parent, not only a `RouteContext`.
  const child = defineChildContext<{ path: '/a'; vars: { v: 1 } }>()('/b');
  expectTypeOf(child.path).toEqualTypeOf<'/a/b'>();
  expectTypeOf(child.vars).toEqualTypeOf<{ v: 1 }>();
}

// Value form: `defineChildContext(parent, path)` infers the parent's path and vars
{
  const root = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const things = defineChildContext(root, '/things');
  expectTypeOf(things.path).toEqualTypeOf<'/api/things'>();
  expectTypeOf(things.vars).toEqualTypeOf<{ user: { id: string } }>();

  const thing = defineChildContext(things, '/:id');
  expectTypeOf(thing.path).toEqualTypeOf<'/api/things/:id'>();
  expectTypeOf(thing.vars).toEqualTypeOf<{ user: { id: string } }>();

  // A `.middleware()` parent passes its added vars down.
  const org = defineChildContext(root, '/orgs/:orgId').middleware<{ org: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const depts = defineChildContext(org, '/departments');
  expectTypeOf(depts.path).toEqualTypeOf<'/api/orgs/:orgId/departments'>();
  expectTypeOf(depts.vars).toEqualTypeOf<{ user: { id: string } } & { org: { id: string } }>();

  // The curried form still compiles and agrees with the value form.
  const curried = defineChildContext<typeof root>()('/things');
  expectTypeOf(curried.path).toEqualTypeOf<typeof things.path>();
  expectTypeOf(curried.vars).toEqualTypeOf<typeof things.vars>();

  // A non-literal segment widens to a template type, as in the curried form.
  const dynamic = '/x' as string;
  expectTypeOf(defineChildContext(root, dynamic).path).toEqualTypeOf<`/api${string}`>();

  // @ts-expect-error — the parent needs `vars`
  defineChildContext({ path: '/a' }, '/b');
}

// A root `'/'` (or `''`) parent does not double the slash, in either form.
{
  const slashRoot = defineRootContext('/', []);
  expectTypeOf(defineChildContext(slashRoot, '/things').path).toEqualTypeOf<'/things'>();
  expectTypeOf(defineChildContext<typeof slashRoot>()('/things').path).toEqualTypeOf<'/things'>();
  expectTypeOf(
    defineChildContext(defineChildContext(slashRoot, '/things'), '/:id').path,
  ).toEqualTypeOf<'/things/:id'>();

  const emptyRoot = defineRootContext('', []);
  expectTypeOf(defineChildContext(emptyRoot, '/things').path).toEqualTypeOf<'/things'>();

  // A trailing slash is dropped only when the segment brings its own.
  expectTypeOf(
    defineChildContext(defineRootContext('/api/', []), '/x').path,
  ).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildContext(slashRoot, 'things').path).toEqualTypeOf<'/things'>();
}

// A segment without a leading `/` is joined with one, in either form.
{
  const api = defineRootContext('/api', []);
  expectTypeOf(defineChildContext(api, 'x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildContext<typeof api>()('x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(
    defineChildContext(defineChildContext(api, 'x'), 'y').path,
  ).toEqualTypeOf<'/api/x/y'>();
  expectTypeOf(defineChildContext(defineRootContext('', []), 'x').path).toEqualTypeOf<'/x'>();
  expectTypeOf(defineChildContext(api, '').path).toEqualTypeOf<'/api'>();
}

// Value form nested inline as an argument of another generic call infers the full path,
// so a path-param-typed helper accepts the param name (as with a variable or the curried form).
{
  const bind = <P extends string>(ctx: RouteContext<P, {}>, param: NoInfer<ParamKeys<P>>) =>
    ctx.middleware<{ org: { id: string } }>(async (c, next) => {
      c.set('org', { id: c.req.param(param) ?? '' });
      await next();
    });

  const root = defineRootContext('/api', []);

  const inline = bind(defineChildContext(root, '/orgs/:orgId'), 'orgId');
  expectTypeOf(inline.path).toEqualTypeOf<'/api/orgs/:orgId'>();
  expectTypeOf(inline.vars).toEqualTypeOf<{ org: { id: string } }>();
  expectTypeOf(inline.middleware).toBeFunction();

  // Grandchild nested inline, and a `'/'` root.
  const deep = bind(
    defineChildContext(defineChildContext(root, '/orgs/:orgId'), '/teams'),
    'orgId',
  );

  expectTypeOf(deep.path).toEqualTypeOf<'/api/orgs/:orgId/teams'>();
  const slash = bind(defineChildContext(defineRootContext('/', []), '/orgs/:orgId'), 'orgId');
  expectTypeOf(slash.path).toEqualTypeOf<'/orgs/:orgId'>();

  // @ts-expect-error — 'nope' is not a param of '/api/orgs/:orgId'
  bind(defineChildContext(root, '/orgs/:orgId'), 'nope');

  // The variable and curried forms keep working.
  const ctx = defineChildContext(root, '/orgs/:orgId');
  expectTypeOf(bind(ctx, 'orgId').path).toEqualTypeOf<'/api/orgs/:orgId'>();
  expectTypeOf(
    bind(defineChildContext<typeof root>()('/orgs/:orgId'), 'orgId').path,
  ).toEqualTypeOf<'/api/orgs/:orgId'>();

  // The curried overload still resolves to the public `ChildRouteFn` type.
  expectTypeOf(defineChildContext<typeof root>()).toEqualTypeOf<ChildRouteFn<typeof root>>();
}

// `createMiddleware` from `hono/factory` passes to `.middleware()`. On a context without
// vars, an Env with only the new vars fits, and one middleware is reused on two contexts.
{
  type Session = { userId: string };

  const loadSession = createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    c.set('session', { userId: 'u1' });
    await next();
  });

  const api = defineRootContext('/api', []).middleware<{ session: Session }>(loadSession);
  const admin = defineRootContext('/admin/:org', []).middleware(loadSession);

  expectTypeOf(api.vars).toEqualTypeOf<{ session: Session }>();
  expectTypeOf(admin.vars).toEqualTypeOf<{ session: Session }>();
}

// On a context that already has vars, a middleware that reads them uses
// `ContextEnv<typeof ctx, NewVars>`. Its type-only `READS` key holds the vars that it reads,
// and its type-only `SETS` key holds the vars that it sets.
{
  type Session = { userId: string };

  const withRequestId = defineRootContext('/api', []).middleware<{ requestId: string }>(
    async (c, next) => {
      c.set('requestId', 'r1');
      await next();
    },
  );

  type Env = ContextEnv<typeof withRequestId, { session: Session }>;

  expectTypeOf<Env['Variables']>().toEqualTypeOf<{ requestId: string } & { session: Session }>();
  expectTypeOf<Env[typeof READS]>().toEqualTypeOf<{ requestId: string }>();
  expectTypeOf<Env[typeof SETS]>().toEqualTypeOf<{ session: Session }>();
  expectTypeOf<keyof Env>().toEqualTypeOf<'Variables' | typeof READS | typeof SETS>();

  const loadSession = createMiddleware<Env>(async (c, next) => {
    expectTypeOf(c.var.requestId).toEqualTypeOf<string>();
    c.set('session', { userId: c.var.requestId });
    await next();
  });

  // The context gets only the vars that the middleware sets.
  const authed = withRequestId.middleware(loadSession);
  expectTypeOf<keyof typeof authed.vars>().toEqualTypeOf<'requestId' | 'session'>();
  expectTypeOf(authed.vars.session).toEqualTypeOf<Session>();

  // @ts-expect-error a type argument selects the inline signature, which does not accept a `ContextEnv` middleware
  withRequestId.middleware<{ session: Session }>(loadSession);

  // A child has the same vars as its parent, so the same middleware fits it.
  const child = defineChildContext(withRequestId, '/things/:id').middleware(loadSession);
  expectTypeOf<keyof typeof child.vars>().toEqualTypeOf<'requestId' | 'session'>();

  // A descendant with more vars also fits.
  const traced = withRequestId.middleware<{ traceId: string }>(async (_c, next) => {
    await next();
  });

  const deeper = defineChildContext(traced, '/x').middleware(loadSession);
  expectTypeOf<keyof typeof deeper.vars>().toEqualTypeOf<'requestId' | 'traceId' | 'session'>();

  // @ts-expect-error This middleware reads vars that the context does not have: requestId
  defineRootContext('/public').middleware(loadSession);

  // An Env with only the new vars (no `READS` key) sets them, and fits a context with
  // other vars.
  const onlySession = createMiddleware<{ Variables: { session: Session } }>(async (_c, next) => {
    await next();
  });

  const fromSetOnly = withRequestId.middleware(onlySession);
  expectTypeOf<keyof typeof fromSetOnly.vars>().toEqualTypeOf<'requestId' | 'session'>();
  expectTypeOf(fromSetOnly.vars.session).toEqualTypeOf<Session>();

  // @ts-expect-error the explicit form requires `Variables` to equal the vars of the context plus the new vars
  withRequestId.middleware<{ session: Session }>(onlySession);
}

// A `ContextEnv` middleware that sets a var that it also reads is a redeclaration: the
// `SETS` key holds the new vars, and the context already has the var.
{
  const withCount = defineRootContext('/count').middleware<{ count: number }>(async (c, next) => {
    c.set('count', 0);
    await next();
  });

  const increment = createMiddleware<ContextEnv<typeof withCount, { count: number }>>(
    async (c, next) => {
      c.set('count', c.var.count + 1);
      await next();
    },
  );

  // @ts-expect-error Cannot redeclare existing var: count
  withCount.middleware(increment);
}

// A chain of `ContextEnv` middlewares, each typed from the previous context, stays linear.
// Each context has the vars of the previous context and the `SETS` vars of one middleware.
// Before the `SETS` key, each context contained an `Omit` of the previous context, and the
// check time grew exponentially (24 levels: 0.9 s on TypeScript 7, 6 s on 5.9). To measure, run
// `tsc -p tsconfig.test-types.json --noEmit --extendedDiagnostics` and compare
// `Instantiations` and `Check time` with and without this block.
{
  const c0 = defineRootContext('/chain');

  const c1 = c0.middleware(
    createMiddleware<ContextEnv<typeof c0, { v1: 1 }>>(async (c, next) => {
      c.set('v1', 1);
      await next();
    }),
  );

  const c2 = c1.middleware(
    createMiddleware<ContextEnv<typeof c1, { v2: 2 }>>(async (c, next) => {
      c.set('v2', 2);
      await next();
    }),
  );

  const c3 = c2.middleware(
    createMiddleware<ContextEnv<typeof c2, { v3: 3 }>>(async (c, next) => {
      c.set('v3', 3);
      await next();
    }),
  );

  const c4 = c3.middleware(
    createMiddleware<ContextEnv<typeof c3, { v4: 4 }>>(async (c, next) => {
      c.set('v4', 4);
      await next();
    }),
  );

  const c5 = c4.middleware(
    createMiddleware<ContextEnv<typeof c4, { v5: 5 }>>(async (c, next) => {
      c.set('v5', 5);
      await next();
    }),
  );

  const c6 = c5.middleware(
    createMiddleware<ContextEnv<typeof c5, { v6: 6 }>>(async (c, next) => {
      c.set('v6', 6);
      await next();
    }),
  );

  const c7 = c6.middleware(
    createMiddleware<ContextEnv<typeof c6, { v7: 7 }>>(async (c, next) => {
      c.set('v7', 7);
      await next();
    }),
  );

  const c8 = c7.middleware(
    createMiddleware<ContextEnv<typeof c7, { v8: 8 }>>(async (c, next) => {
      c.set('v8', 8);
      await next();
    }),
  );

  const c9 = c8.middleware(
    createMiddleware<ContextEnv<typeof c8, { v9: 9 }>>(async (c, next) => {
      c.set('v9', 9);
      await next();
    }),
  );

  const c10 = c9.middleware(
    createMiddleware<ContextEnv<typeof c9, { v10: 10 }>>(async (c, next) => {
      c.set('v10', 10);
      await next();
    }),
  );

  const c11 = c10.middleware(
    createMiddleware<ContextEnv<typeof c10, { v11: 11 }>>(async (c, next) => {
      c.set('v11', 11);
      await next();
    }),
  );

  const c12 = c11.middleware(
    createMiddleware<ContextEnv<typeof c11, { v12: 12 }>>(async (c, next) => {
      c.set('v12', 12);
      await next();
    }),
  );

  expectTypeOf<keyof typeof c12.vars>().toEqualTypeOf<
    'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' | 'v7' | 'v8' | 'v9' | 'v10' | 'v11' | 'v12'
  >();
  expectTypeOf(c12.vars.v12).toEqualTypeOf<12>();
  expectTypeOf(c12.vars.v1).toEqualTypeOf<1>();
}

// A typed middleware without the `READS` key sets all its `Variables`: a var that the context
// has is a redeclaration, even with the same type. This is the difference from an inferred
// "added vars" subtraction, which accepted such a middleware and widened silently.
{
  type Session = { userId: string };

  const requireSession = createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    c.set('session', { userId: 'u1' });
    await next();
  });

  const api = defineRootContext('/api').middleware(requireSession);

  const otherType = createMiddleware<{ Variables: { session: string; x: 1 } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error Cannot redeclare existing var: session
  api.middleware(otherType);

  const sameType = createMiddleware<{ Variables: { session: Session; x: 1 } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error Cannot redeclare existing var: session
  api.middleware(sameType);

  // Known limit: the same middleware a second time is not detected. The inline signature
  // matches it with no new vars.
  const twice = api.middleware(requireSession);
  expectTypeOf<keyof typeof twice.vars>().toEqualTypeOf<'session'>();

  // A middleware with only `Bindings`, or with `Bindings` and `Variables`, fits. The
  // context gets the `Variables`; the `Bindings` are not added.
  const bindingsOnly = createMiddleware<{ Bindings: { DB: string } }>(async (_c, next) => {
    await next();
  });

  expectTypeOf(api.middleware(bindingsOnly).vars).toEqualTypeOf<{ session: Session }>();

  const bindingsAndVars = createMiddleware<{
    Bindings: { DB: string };
    Variables: { db: string };
  }>(async (_c, next) => {
    await next();
  });

  const withDb = api.middleware(bindingsAndVars);
  expectTypeOf<keyof typeof withDb.vars>().toEqualTypeOf<'session' | 'db'>();

  // A `ContextEnv` with `Bindings` keeps the read marker.
  const readsWithBindings = createMiddleware<
    ContextEnv<typeof api, { tenantId: string }> & { Bindings: { DB: string } }
  >(async (c, next) => {
    c.set('tenantId', c.env.DB + c.var.session.userId);
    await next();
  });

  const withTenant = api.middleware(readsWithBindings);
  expectTypeOf<keyof typeof withTenant.vars>().toEqualTypeOf<'session' | 'tenantId'>();

  // An inline arrow keeps a typed `c` without a type argument.
  api.middleware(async (c, next) => {
    expectTypeOf(c.var.session).toEqualTypeOf<Session>();
    await next();
  });

  // With a type argument, an error in the arrow stays in the arrow body.
  api.middleware<{ tenantId: string }>(async (c, next) => {
    // @ts-expect-error `tenantId` is a string
    c.set('tenantId', 42);
    await next();
  });
}

// Untyped `createMiddleware` results in `defineRootContext(path, [a, b])` keep `vars` as `{}`
{
  const a = createMiddleware(async (_c, next) => {
    await next();
  });

  const b = createMiddleware(async (_c, next) => {
    await next();
  });

  expectTypeOf(defineRootContext('/api', [a, b]).vars).toEqualTypeOf<{}>();
}

// The root array folds the vars of typed middlewares with different `Variables`.
{
  type IsAny<T> = 0 extends 1 & T ? true : false;

  type Flat<T> = { [K in keyof T]: T[K] } & {};

  interface AVars {
    a: string;
  }

  const a = createMiddleware<{ Variables: AVars }>(async (c, next) => {
    c.set('a', 'x');
    await next();
  });

  const b = createMiddleware<{ Variables: { b: number } }>(async (c, next) => {
    c.set('b', 1);
    await next();
  });

  const plain: MiddlewareHandler = async (_c, next) => {
    await next();
  };

  const timing = createMiddleware(async (_c, next) => {
    await next();
  });

  const folded = defineRootContext('/api', [a, b]);
  expectTypeOf(folded.path).toEqualTypeOf<'/api'>();
  expectTypeOf<Flat<typeof folded.vars>>().toEqualTypeOf<{ a: string; b: number }>();

  // A later `.middleware` sees both vars.
  const next1 = folded.middleware<{ c: boolean }>(async (c, next) => {
    expectTypeOf(c.var.a).toEqualTypeOf<string>();
    expectTypeOf(c.var.b).toEqualTypeOf<number>();
    c.set('c', true);
    await next();
  });

  expectTypeOf<Flat<typeof next1.vars>>().toEqualTypeOf<{ a: string; b: number; c: boolean }>();
  folded.middleware(async (c, next) => {
    expectTypeOf(c.var.a).toEqualTypeOf<string>();
    expectTypeOf(c.var.b).toEqualTypeOf<number>();
    await next();
  });

  // Untyped middlewares add no vars.
  const mixed = defineRootContext('/api', [timing, a, plain, b]);
  expectTypeOf<Flat<typeof mixed.vars>>().toEqualTypeOf<{ a: string; b: number }>();

  const plains = defineRootContext('/api', [plain, plain]);
  expectTypeOf<IsAny<typeof plains.vars>>().toEqualTypeOf<false>();
  expectTypeOf<Flat<typeof plains.vars>>().toEqualTypeOf<{}>();

  const timings = defineRootContext('/api', [timing, timing]);
  expectTypeOf<IsAny<typeof timings.vars>>().toEqualTypeOf<false>();
  expectTypeOf<Flat<typeof timings.vars>>().toEqualTypeOf<{}>();

  const empty = defineRootContext('/api', []);
  expectTypeOf<IsAny<typeof empty.vars>>().toEqualTypeOf<false>();
  expectTypeOf<Flat<typeof empty.vars>>().toEqualTypeOf<{}>();

  const list: MiddlewareHandler[] = [plain];
  const fromList = defineRootContext('/api', list);
  expectTypeOf<IsAny<typeof fromList.vars>>().toEqualTypeOf<false>();
  expectTypeOf<Flat<typeof fromList.vars>>().toEqualTypeOf<{}>();

  // One typed middleware gives its vars.
  const single = defineRootContext('/api', [a]);
  expectTypeOf<Flat<typeof single.vars>>().toEqualTypeOf<{ a: string }>();

  // Explicit type arguments still select the first signature.
  const explicit = defineRootContext<'/api', AVars>('/api', [a]);
  expectTypeOf(explicit.vars).toEqualTypeOf<AVars>();

  // An inline arrow alone in the array is typed by the first signature: it cannot set an
  // undeclared var.
  defineRootContext('/api', [
    async (c, next) => {
      expectTypeOf<IsAny<typeof c>>().toEqualTypeOf<false>();
      // @ts-expect-error `foo` is not a declared var
      c.set('foo', 1);
      await next();
    },
  ]);

  // A spread of a `MiddlewareHandler[]` followed by a typed middleware gives that
  // middleware's vars, as before the fold signature.
  const fromSpread = defineRootContext('/api', [...list, a]);
  expectTypeOf(fromSpread.vars).toEqualTypeOf<AVars>();
  fromSpread.middleware(async (c, next) => {
    expectTypeOf(c.var.a).toEqualTypeOf<string>();
    await next();
  });

  // An untyped `createMiddleware<any>` between typed middlewares adds no vars.
  const anyEnv = createMiddleware<any>(async (_c, next) => {
    await next();
  });

  const withAnyEnv = defineRootContext('/api', [a, anyEnv, b]);
  expectTypeOf<Flat<typeof withAnyEnv.vars>>().toEqualTypeOf<{ a: string; b: number }>();

  // A middleware that declares only `Bindings` adds no vars.
  const bindingsOnly: MiddlewareHandler<{ Bindings: { KV: string } }> = async (_c, next) => {
    await next();
  };

  const fromBindings = defineRootContext('/api', [bindingsOnly]);
  expectTypeOf<IsAny<typeof fromBindings.vars>>().toEqualTypeOf<false>();
  expectTypeOf<Flat<typeof fromBindings.vars>>().toEqualTypeOf<{}>();

  // Three explicit type arguments select the fold signature. This compiles but has no use.
  const explicitFold = defineRootContext<'/api', [typeof a, typeof b], unknown>('/api', [a, b]);
  expectTypeOf<Flat<typeof explicitFold.vars>>().toEqualTypeOf<{ a: string; b: number }>();

  // An inline arrow together with typed middlewares that declare different vars: the vars
  // are still the fold. The arrow's `c` is not asserted, because it differs by compiler:
  // TypeScript 7 gives `Context<any>` (so `c.set('foo', 1)` compiles), and TypeScript 5.9
  // types the keys of `c.set`/`c.get` as `never`, so it reports an error. Use
  // `createMiddleware` or `.middleware()`.
  const withArrow = defineRootContext('/api', [
    a,
    b,
    async (_c, next) => {
      await next();
    },
  ]);

  expectTypeOf<Flat<typeof withArrow.vars>>().toEqualTypeOf<{ a: string; b: number }>();
}

// Two middlewares that set the same var with different types are an error. The same type is
// allowed.
{
  type Flat<T> = { [K in keyof T]: T[K] } & {};

  const stringId = createMiddleware<{ Variables: { id: string; a: 1 } }>(async (_c, next) => {
    await next();
  });

  const numberId = createMiddleware<{ Variables: { id: number } }>(async (_c, next) => {
    await next();
  });

  const literalId = createMiddleware<{ Variables: { id: 'x' } }>(async (_c, next) => {
    await next();
  });

  const sameId = createMiddleware<{ Variables: { id: string; b: 2 } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error Middlewares in the array declare the same var with different types: id
  defineRootContext('/api', [stringId, numberId]);

  // A narrower type is also a different type.
  // @ts-expect-error Middlewares in the array declare the same var with different types: id
  defineRootContext('/api', [stringId, literalId]);

  const shared = defineRootContext('/api', [stringId, sameId]);
  expectTypeOf<Flat<typeof shared.vars>>().toEqualTypeOf<{ id: string; a: 1; b: 2 }>();

  // Two literal types of one key make the fold `never`. The message names only that key.
  const kindA = createMiddleware<{ Variables: { kind: 'a'; id: string } }>(async (_c, next) => {
    await next();
  });

  const kindB = createMiddleware<{ Variables: { kind: 'b'; id: string } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error Middlewares in the array declare the same var with different types: kind
  defineRootContext('/api', [kindA, kindB]);
}

// An array variable with mixed middlewares has one union element type, so the fold cannot
// tell which middleware sets which var. Pass a tuple literal or `as const`.
{
  type Flat<T> = { [K in keyof T]: T[K] } & {};

  const a = createMiddleware<{ Variables: { a: string } }>(async (_c, next) => {
    await next();
  });

  const b = createMiddleware<{ Variables: { b: number } }>(async (_c, next) => {
    await next();
  });

  const untyped = createMiddleware(async (_c, next) => {
    await next();
  });

  const mixed = [a, b];
  // @ts-expect-error Pass the middlewares as a tuple literal or as const: an array variable with mixed middlewares has one union element type
  defineRootContext('/api', mixed);
  // The spread form is also an error, but TypeScript reports it on each element without the
  // message.
  // @ts-expect-error the element type of `mixed` is a union
  defineRootContext('/api', [...mixed, a]);

  const asConst = [a, b] as const;
  const fromConst = defineRootContext('/api', asConst);
  expectTypeOf<Flat<typeof fromConst.vars>>().toEqualTypeOf<{ a: string; b: number }>();

  const inlineConst = defineRootContext('/api', [a, b] as const);
  expectTypeOf<Flat<typeof inlineConst.vars>>().toEqualTypeOf<{ a: string; b: number }>();

  // An array variable of one middleware type, or of untyped middlewares, keeps working.
  const onlyA = [a, a];
  expectTypeOf(defineRootContext('/api', onlyA).vars).toEqualTypeOf<{ a: string }>();

  const untypedList = [untyped, untyped];
  expectTypeOf(defineRootContext('/api', untypedList).vars).toEqualTypeOf<{}>();

  // A typed and an untyped middleware: the first signature gives the typed vars.
  const typedAndUntyped = [a, untyped];
  expectTypeOf(defineRootContext('/api', typedAndUntyped).vars).toEqualTypeOf<{ a: string }>();
}

// A `ContextEnv` middleware in the root array adds only the vars that it sets. Another
// middleware of the array must set the vars that it reads; the order is not checked.
{
  type Flat<T> = { [K in keyof T]: T[K] } & {};

  const requireSession = createMiddleware<{ Variables: { session: string } }>(async (c, next) => {
    c.set('session', 's');
    await next();
  });

  const sessionContext = defineRootContext('/api', [requireSession]);

  const loadTenant = createMiddleware<ContextEnv<typeof sessionContext, { tenantId: string }>>(
    async (c, next) => {
      c.set('tenantId', c.var.session);
      await next();
    },
  );

  const root = defineRootContext('/api', [requireSession, loadTenant]);
  expectTypeOf<Flat<typeof root.vars>>().toEqualTypeOf<{ session: string; tenantId: string }>();

  // @ts-expect-error This middleware reads vars that the root context does not have: session
  defineRootContext('/api', [loadTenant]);
}

// `middlewares` is optional: a root without middlewares has no vars.
{
  type IsAny<T> = 0 extends 1 & T ? true : false;

  const bare = defineRootContext('/api');
  expectTypeOf(bare.path).toEqualTypeOf<'/api'>();
  expectTypeOf(bare.vars).toEqualTypeOf<{}>();
  expectTypeOf<IsAny<typeof bare.vars>>().toEqualTypeOf<false>();
  expectTypeOf(defineRootRoute('/api').vars).toEqualTypeOf<{}>();

  const withVars = bare.middleware<{ a: string }>(async (_c, next) => {
    await next();
  });

  expectTypeOf(withVars.vars).toEqualTypeOf<{ a: string }>();
}

// The deprecated names are aliases: their types equal the types of the new names.
{
  expectTypeOf<typeof defineRootRoute>().toEqualTypeOf<typeof defineRootContext>();
  expectTypeOf<typeof defineChildRoute>().toEqualTypeOf<typeof defineChildContext>();
}

// The `{param}` check of a context path runs only at runtime, so a generic wrapper can pass
// its path through and keep the literal type.
{
  const root = defineRootContext('/api');
  const child = <P extends string>(path: P) => defineChildContext(root, path);
  const wrap = <P extends string>(path: P) => defineRootContext(path);

  expectTypeOf(child('/things/:id').path).toEqualTypeOf<'/api/things/:id'>();
  expectTypeOf(wrap('/api/:id').path).toEqualTypeOf<'/api/:id'>();
}

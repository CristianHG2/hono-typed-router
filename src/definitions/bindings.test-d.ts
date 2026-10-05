import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { createScopeMiddleware } from '../scopes';
import { defineChildContext, defineRootContext } from './lib';
import type { ContextEnv, READS, RouteContext, SETS } from './types';

type Flat<T> = { [K in keyof T]: T[K] } & {};

interface Db {
  query: (sql: string) => string;
}

interface Bindings {
  DB: Db;
}

interface SessionVars {
  session: { userId: string };
}

const auth = createMiddleware<{ Bindings: Bindings; Variables: SessionVars }>(async (c, next) => {
  c.set('session', { userId: c.env.DB.query('select 1') });
  await next();
});

const authVarsOnly = createMiddleware<{ Variables: SessionVars }>(async (c, next) => {
  c.set('session', { userId: 'u1' });
  await next();
});

const kv = createMiddleware<{ Bindings: { KV: string }; Variables: { tenant: string } }>(
  async (c, next) => {
    c.set('tenant', c.env.KV);
    await next();
  },
);

// A context without bindings has `{}` bindings.
{
  expectTypeOf(defineRootContext('/api')).toEqualTypeOf<RouteContext<'/api', {}>>();
  expectTypeOf(defineRootContext('/api', [authVarsOnly])).toEqualTypeOf<
    RouteContext<'/api', SessionVars>
  >();
  expectTypeOf(defineRootContext('/api').bindings).toEqualTypeOf<{}>();
}

// An explicit third type argument declares the bindings.
{
  const api = defineRootContext<'/api', SessionVars, Bindings>('/api', [auth]);
  expectTypeOf(api).toEqualTypeOf<RouteContext<'/api', SessionVars, Bindings>>();

  const bare = defineRootContext<'/api', {}, Bindings>('/api');
  expectTypeOf(bare.bindings).toEqualTypeOf<Bindings>();

  // With explicit bindings, a middleware typed only with `Variables` does not fit the array.
  // See `DefineRootContextFn`.
  // @ts-expect-error the middleware does not declare the `Bindings`
  defineRootContext<'/api', SessionVars, Bindings>('/api', [authVarsOnly]);

  const added = bare.middleware(authVarsOnly);
  expectTypeOf(added).toEqualTypeOf<RouteContext<'/api', {} & SessionVars, Bindings>>();

  // An inline arrow in the array gets typed bindings.
  defineRootContext<'/api', SessionVars, Bindings>('/api', [
    async (c, next) => {
      expectTypeOf(c.env.DB).toEqualTypeOf<Db>();
      c.set('session', { userId: c.env.DB.query('select 1') });
      await next();
    },
  ]);
}

// The root array gives the bindings of its middlewares. The fold intersects them.
{
  const one = defineRootContext('/api', [auth]);
  expectTypeOf(one).toEqualTypeOf<RouteContext<'/api', SessionVars, Bindings>>();

  const folded = defineRootContext('/api', [auth, kv]);
  expectTypeOf<Flat<typeof folded.bindings>>().toEqualTypeOf<{ DB: Db; KV: string }>();
  expectTypeOf<Flat<typeof folded.vars>>().toEqualTypeOf<{
    session: { userId: string };
    tenant: string;
  }>();

  const bindingsOnly: MiddlewareHandler<{ Bindings: { KV: string } }> = async (_c, next) => {
    await next();
  };

  const fromBindings = defineRootContext('/api', [authVarsOnly, bindingsOnly]);
  expectTypeOf(fromBindings.vars).toEqualTypeOf<SessionVars>();
  expectTypeOf(fromBindings.bindings).toEqualTypeOf<{ KV: string }>();

  // An untyped middleware adds no bindings.
  const timing = createMiddleware(async (_c, next) => {
    await next();
  });

  const withTiming = defineRootContext('/api', [timing, auth]);
  expectTypeOf(withTiming.bindings).toEqualTypeOf<Bindings>();
}

// Two middlewares in the root array that declare the same binding with different types are an
// error. The same type is accepted.
{
  const kvString = createMiddleware<{ Bindings: { KV: string } }>(async (_c, next) => {
    await next();
  });

  const kvNumber = createMiddleware<{ Bindings: { KV: number }; Variables: { a: 1 } }>(
    async (_c, next) => {
      await next();
    },
  );

  // @ts-expect-error Middlewares in the array declare the same binding with different types: KV
  defineRootContext('/k', [kvString, kvNumber]);

  // @ts-expect-error Middlewares in the array declare the same binding with different types: KV
  defineRootContext('/k', [kv, kvNumber]);

  const shared = defineRootContext('/k', [kv, kvString]);
  expectTypeOf(shared.bindings).toEqualTypeOf<{ KV: string }>();
  expectTypeOf(shared.vars).toEqualTypeOf<{ tenant: string }>();
}

// `.middleware()` gives `c.env` the bindings of the context, and adds the `Bindings` of a
// reusable middleware without a check.
{
  const api = defineRootContext('/api', [auth]);

  const inline = api.middleware<{ requestId: string }>(async (c, next) => {
    expectTypeOf(c.env.DB).toEqualTypeOf<Db>();
    expectTypeOf(c.var.session).toEqualTypeOf<{ userId: string }>();
    c.set('requestId', c.env.DB.query('select 1'));
    await next();
  });

  expectTypeOf(inline).toEqualTypeOf<
    RouteContext<'/api', SessionVars & { requestId: string }, Bindings>
  >();

  api.middleware(async (c, next) => {
    expectTypeOf(c.env.DB).toEqualTypeOf<Db>();
    await next();
  });

  // @ts-expect-error `NoRedeclare` rejects the type argument
  api.middleware<{ session: string }>(async (_c, next) => {
    await next();
  });

  // Without bindings, `c.env` is `unknown`.
  defineRootContext('/api').middleware(async (c, next) => {
    expectTypeOf(c.env).toEqualTypeOf<unknown>();
    await next();
  });

  const withKv = api.middleware(kv);
  expectTypeOf<Flat<typeof withKv.bindings>>().toEqualTypeOf<{ DB: Db; KV: string }>();

  const plain = createMiddleware<{ Variables: { requestId: string } }>(async (_c, next) => {
    await next();
  });

  expectTypeOf(api.middleware(plain)).toEqualTypeOf<
    RouteContext<'/api', SessionVars & { requestId: string }, Bindings>
  >();

  // On a context with bindings, a middleware typed only with `Variables` uses its own signature.
  // A second use of it, or a middleware with more vars, compiles.
  const withSession = defineRootContext<'/api', {}, Bindings>('/api').middleware(authVarsOnly);
  expectTypeOf(withSession.middleware(authVarsOnly).vars).toEqualTypeOf<SessionVars>();

  const wider = createMiddleware<{ Variables: SessionVars & { tenant: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const widerOnBindings = withSession.middleware(wider);
  expectTypeOf<keyof typeof widerOnBindings.vars>().toEqualTypeOf<'session' | 'tenant'>();
  expectTypeOf(widerOnBindings.bindings).toEqualTypeOf<Bindings>();

  widerOnBindings.middleware(async (c, next) => {
    expectTypeOf(c.env.DB).toEqualTypeOf<Db>();
    expectTypeOf(c.var.tenant).toEqualTypeOf<string>();
    await next();
  });

  // Without bindings, the inline signature matches both.
  const noBindings = defineRootContext('/api').middleware(authVarsOnly);
  expectTypeOf(noBindings.middleware(authVarsOnly).vars).toEqualTypeOf<SessionVars>();
  const widened = noBindings.middleware(wider);
  expectTypeOf<keyof typeof widened.vars>().toEqualTypeOf<'session' | 'tenant'>();
}

// `ContextEnv` adds `Bindings` only when the context has bindings.
{
  const plain = defineRootContext('/api', [authVarsOnly]);
  expectTypeOf<ContextEnv<typeof plain, { a: 1 }>>().toEqualTypeOf<{
    Variables: SessionVars & { a: 1 };
    readonly [READS]: SessionVars;
    readonly [SETS]: { a: 1 };
  }>();

  const api = defineRootContext('/api', [auth]);
  expectTypeOf<ContextEnv<typeof api, { a: 1 }>>().toEqualTypeOf<{
    Bindings: Bindings;
    Variables: SessionVars & { a: 1 };
    readonly [READS]: SessionVars;
    readonly [SETS]: { a: 1 };
  }>();

  const tenant = createMiddleware<ContextEnv<typeof api, { tenantId: string }>>(async (c, next) => {
    c.set('tenantId', c.env.DB.query(c.var.session.userId));
    await next();
  });

  const withTenant = api.middleware(tenant);
  expectTypeOf(withTenant.bindings).toEqualTypeOf<Bindings>();
  expectTypeOf<keyof typeof withTenant.vars>().toEqualTypeOf<'session' | 'tenantId'>();
}

// Children get the bindings of the parent, in both forms.
{
  const api = defineRootContext('/api', [auth]);

  expectTypeOf(defineChildContext(api, '/things')).toEqualTypeOf<
    RouteContext<'/api/things', SessionVars, Bindings>
  >();
  expectTypeOf(defineChildContext<typeof api>()('/things')).toEqualTypeOf<
    RouteContext<'/api/things', SessionVars, Bindings>
  >();

  // A `{ path; vars }` object without `bindings` gives no bindings.
  const parentLike = { path: '/p' as const, vars: {} as SessionVars };
  expectTypeOf(defineChildContext(parentLike, '/x')).toEqualTypeOf<
    RouteContext<'/p/x', SessionVars>
  >();
  expectTypeOf(defineChildContext<typeof parentLike>()('/x')).toEqualTypeOf<
    RouteContext<'/p/x', SessionVars>
  >();

  // A value-form child nested inline in another generic call keeps its path.
  const nested = defineChildContext(defineChildContext(api, '/:id'), '/z').bind(
    'thing',
    'id',
    (id, c) => c.env.DB.query(id),
  );

  expectTypeOf(nested.path).toEqualTypeOf<'/api/:id/z'>();
  expectTypeOf(nested.bindings).toEqualTypeOf<Bindings>();
}

// `.bind()` gives the loader the bindings, and the result keeps them. A bound context is
// assignable to a context with fewer vars.
{
  const api = defineRootContext<'/api/:id', SessionVars, Bindings>('/api/:id', [auth]);

  const bound = api.bind('thing', 'id', (id, c) => {
    expectTypeOf(c.env.DB).toEqualTypeOf<Db>();

    return { id, row: c.env.DB.query(id) };
  });

  expectTypeOf(bound.bindings).toEqualTypeOf<Bindings>();
  expectTypeOf(bound).toExtend<RouteContext<'/api/:id', SessionVars, Bindings>>();
  expectTypeOf(defineRootContext('/x/:id').bind('n', 'id', Number)).toExtend<
    RouteContext<'/x/:id', {}>
  >();

  // A context with bindings is not assignable to a context without them, because Hono's
  // `Context` is invariant in its `Env`. `ParentContext` and `{ path; vars }` accept both.
  expectTypeOf(api).not.toExtend<RouteContext<string, object>>();
}

// The context form of `createScopeMiddleware` types `c.env` with the bindings of the context.
{
  const api = defineRootContext('/api', [auth]);

  createScopeMiddleware(api, {
    resolve: (c) => {
      expectTypeOf(c.env.DB).toEqualTypeOf<Db>();

      return [c.var.session.userId];
    },
    onForbidden: (missing, c) => ({ missing, db: c.env.DB.query('select 1') }),
  });

  createScopeMiddleware<SessionVars, Bindings>({
    resolve: (c) => [c.env.DB.query(c.var.session.userId)],
  });

  createScopeMiddleware(defineRootContext('/api', [authVarsOnly]), {
    resolve: (c) => {
      expectTypeOf(c.env).toEqualTypeOf<unknown>();

      return [c.var.session.userId];
    },
  });
}

// A middleware typed `{ Variables: any }` makes the vars `any`, with or without bindings.
{
  const anyVars: MiddlewareHandler<{ Variables: any }> = async (_c, next) => {
    await next();
  };

  type IsAny<T> = 0 extends 1 & T ? true : false;

  const withBindings = defineRootContext('/api', [auth]).middleware(anyVars);
  expectTypeOf<IsAny<typeof withBindings.vars>>().toEqualTypeOf<true>();
  expectTypeOf(withBindings.bindings).toEqualTypeOf<Bindings>();

  const without = defineRootContext('/api').middleware(anyVars);
  expectTypeOf<IsAny<typeof without.vars>>().toEqualTypeOf<true>();
}

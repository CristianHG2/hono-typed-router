import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ParamKeys } from 'hono/types';
import { extendRouteContext } from './extend';
import type { ContextEnv } from './types';
import type {
  ExtendRouteContextResult,
  ReaugmentContext,
  RouteContextBase,
  RouteContextKind,
} from './extend';

// A representative extension: bind a param-derived value under a new, typed var,
// guarding against redeclaration — exercises path threading (ParamKeys), the vars
// merge, and re-augmentation of the return.
interface TestContext<TPath extends string, TVars extends object> extends RouteContextBase<
  TestContextKind,
  TPath,
  TVars
> {
  bindValue: <TKey extends string, TValue>(
    key: TKey extends keyof TVars ? `Cannot redeclare existing var: "${TKey}"` : TKey,
    param: ParamKeys<TPath>,
    produce: (id: string) => TValue,
  ) => ReaugmentContext<TestContextKind, TPath, TVars & { [K in TKey]: TValue }>;
}

interface TestContextKind extends RouteContextKind {
  type: TestContext<this['path'] & string, this['vars'] & object>;
}

const { defineRootContext, defineChildContext } = extendRouteContext<TestContextKind>({
  bindValue: (ctx) => (_key: string, _param: string, _produce: (id: string) => unknown) =>
    ctx.middleware(((_c: unknown, next: () => Promise<void>) => next()) as never),
});

// Root context is augmented with the extension method and preserves the path.
{
  const ctx = defineRootContext('/api/:tenantId', []);
  expectTypeOf(ctx.path).toEqualTypeOf<'/api/:tenantId'>();
  expectTypeOf(ctx.bindValue).toBeFunction();
}

// The extension method threads path + vars: adds a typed var and re-augments, so
// the returned context still has `bindValue`.
{
  const ctx = defineRootContext('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => ({
    id,
  }));

  expectTypeOf(ctx.vars).toMatchTypeOf<{ tenant: { id: string } }>();
  expectTypeOf(ctx.bindValue).toBeFunction();
}

// `param` is constrained to the route's path params.
{
  const ctx = defineRootContext('/api/:tenantId', []);
  // @ts-expect-error — 'nope' is not a param of '/api/:tenantId'
  ctx.bindValue('tenant', 'nope', (id) => id);
}

// Redeclaring an existing var yields the guard string, not a valid key.
{
  const ctx = defineRootContext('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => id);
  // @ts-expect-error — 'tenant' already exists; key position must reject it
  ctx.bindValue('tenant', 'tenantId', (id) => id);
}

// Extensions survive `.middleware()` chaining.
{
  const ctx = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  expectTypeOf(ctx.bindValue).toBeFunction();
  expectTypeOf(ctx.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `.middleware()` still rejects redeclaring an existing var.
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

// Child routes concatenate the path, inherit vars, and stay augmented.
{
  const parent = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const child = defineChildContext<typeof parent>()('/things/:id');
  expectTypeOf(child.path).toEqualTypeOf<'/api/things/:id'>();
  expectTypeOf(child.vars).toMatchTypeOf<{ user: { id: string } }>();
  expectTypeOf(child.bindValue).toBeFunction();

  const bound = child.bindValue('thing', 'id', (id) => Number(id));
  expectTypeOf(bound.vars).toMatchTypeOf<{ user: { id: string }; thing: number }>();
}

// Builder implementations get their parameters from the context interface (not `any`)
// and must return a context.
{
  extendRouteContext<TestContextKind>({
    bindValue: (ctx) => (key, param, produce) => {
      expectTypeOf(key).not.toBeAny();
      expectTypeOf(param).not.toBeAny();
      expectTypeOf(produce).not.toBeAny();
      expectTypeOf(produce).parameters.toEqualTypeOf<[id: string]>();
      // @ts-expect-error — `key` is a string, so it is not assignable to `0` (it would be if `any`)
      const asZero: 0 = key;
      void asZero;

      return ctx.middleware(async (_c, next) => {
        await next();
      });
    },
  });

  extendRouteContext<TestContextKind>({
    // @ts-expect-error — a builder must return a context, not a number
    bindValue: () => () => 42,
  });
}

// The extended `defineChildContext` shares the `ParentContext` constraint
{
  // @ts-expect-error — `{ path: '/a' }` has no `vars`, so it fails the `ParentContext` constraint
  defineChildContext<{ path: '/a' }>();
}

// Value form on an extended context: path, vars and builders carry over, and a
// grandchild keeps chaining.
{
  const root = defineRootContext('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => ({
    id,
  }));

  const child = defineChildContext(root, '/things/:id');
  expectTypeOf(child.path).toEqualTypeOf<'/api/:tenantId/things/:id'>();
  expectTypeOf(child.vars).toMatchTypeOf<{ tenant: { id: string } }>();

  const bound = child.bindValue('thing', 'id', (id) => Number(id));
  expectTypeOf(bound.vars).toMatchTypeOf<{ tenant: { id: string }; thing: number }>();
  expectTypeOf(bound.bindValue).toBeFunction();

  const grandchild = defineChildContext(bound, '/parts').middleware<{ part: string }>(
    async (_c, next) => {
      await next();
    },
  );

  expectTypeOf(grandchild.path).toEqualTypeOf<'/api/:tenantId/things/:id/parts'>();
  expectTypeOf(grandchild.vars).toMatchTypeOf<{
    tenant: { id: string };
    thing: number;
    part: string;
  }>();
  expectTypeOf(grandchild.bindValue).toBeFunction();

  // The curried form still compiles.
  const curried = defineChildContext<typeof root>()('/things/:id');
  expectTypeOf(curried.path).toEqualTypeOf<typeof child.path>();
}

// A root `'/'` parent does not double the slash on an extended context either.
{
  const slashRoot = defineRootContext('/', []);
  const child = defineChildContext(slashRoot, '/things');
  expectTypeOf(child.path).toEqualTypeOf<'/things'>();
  expectTypeOf(child.bindValue).toBeFunction();
  expectTypeOf(defineChildContext<typeof slashRoot>()('/things').path).toEqualTypeOf<'/things'>();
}

// A segment without a leading `/` is joined with one on an extended context too.
{
  const api = defineRootContext('/api', []);
  expectTypeOf(defineChildContext(api, 'x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildContext<typeof api>()('x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildContext(defineRootContext('', []), 'x').path).toEqualTypeOf<'/x'>();
}

// Value form nested inline as an argument of another generic call infers the full path
// on an extended context too.
{
  const bind = <P extends string>(ctx: TestContext<P, {}>, param: NoInfer<ParamKeys<P>>) =>
    ctx.bindValue('org', param, (id) => ({ id }));

  const root = defineRootContext('/api', []);

  const inline = bind(defineChildContext(root, '/orgs/:orgId'), 'orgId');
  expectTypeOf(inline.path).toEqualTypeOf<'/api/orgs/:orgId'>();
  expectTypeOf(inline.vars).toMatchTypeOf<{ org: { id: string } }>();
  expectTypeOf(inline.bindValue).toBeFunction();

  const deep = bind(
    defineChildContext(defineChildContext(root, '/orgs/:orgId'), '/teams'),
    'orgId',
  );

  expectTypeOf(deep.path).toEqualTypeOf<'/api/orgs/:orgId/teams'>();

  // @ts-expect-error — 'nope' is not a param of '/api/orgs/:orgId'
  bind(defineChildContext(root, '/orgs/:orgId'), 'nope');

  // The curried form keeps working inline and still returns a callable child builder.
  expectTypeOf(
    bind(defineChildContext<typeof root>()('/orgs/:orgId'), 'orgId').path,
  ).toEqualTypeOf<'/api/orgs/:orgId'>();
  const childOf = defineChildContext<typeof root>();
  expectTypeOf(childOf('/x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(childOf('/x').bindValue).toBeFunction();
}

// The extended `defineRootContext` folds the vars of typed middlewares in the root array.
{
  type IsAny<T> = 0 extends 1 & T ? true : false;

  type Flat<T> = { [K in keyof T]: T[K] } & {};

  type Session = { userId: string };

  const a = createMiddleware<{ Variables: { a: string } }>(async (_c, next) => {
    await next();
  });

  const b = createMiddleware<{ Variables: { b: number } }>(async (_c, next) => {
    await next();
  });

  const plainMw: MiddlewareHandler = async (_c, next) => {
    await next();
  };

  const folded = defineRootContext('/e', [a, b]);
  expectTypeOf<Flat<typeof folded.vars>>().toEqualTypeOf<{ a: string; b: number }>();
  expectTypeOf(folded.bindValue).toBeFunction();

  // No array and an empty array give `{}`, not `object`.
  const bare = defineRootContext('/e');
  expectTypeOf<IsAny<typeof bare.vars>>().toEqualTypeOf<false>();
  expectTypeOf(bare.vars).toEqualTypeOf<{}>();
  expectTypeOf(defineRootContext('/e', []).vars).toEqualTypeOf<{}>();

  // A `MiddlewareHandler[]` variable gives `{}`, not `object`.
  const list: MiddlewareHandler[] = [];
  expectTypeOf(defineRootContext('/e', list).vars).toEqualTypeOf<{}>();
  expectTypeOf(defineRootContext('/e', [plainMw] as MiddlewareHandler[]).vars).toEqualTypeOf<{}>();

  // Typed middlewares with different vars give their intersection, with no leading `object &`.
  expectTypeOf(defineRootContext('/e', [a, b]).vars).toEqualTypeOf<{ a: string } & { b: number }>();

  // A long chain on a folded root keeps every var and the extension (no TS2589).
  const chained = defineRootContext('/e/:id', [a, b])
    .middleware<{ session: Session }>(async (c, next) => {
      c.set('session', { userId: c.var.a });
      await next();
    })
    .bindValue('n', 'id', () => 1)
    .middleware<{ tenantId: string }>(async (c, next) => {
      c.set('tenantId', c.var.session.userId);
      await next();
    })
    .bindValue('z', 'id', () => 'z');

  expectTypeOf<Flat<typeof chained.vars>>().toEqualTypeOf<{
    a: string;
    b: number;
    session: Session;
    n: number;
    tenantId: string;
    z: string;
  }>();
  expectTypeOf(chained.bindValue).toBeFunction();
}

// The extended `.middleware()` accepts a reusable typed middleware and keeps the extension.
{
  type Flat<T> = { [K in keyof T]: T[K] } & {};

  type Session = { userId: string };

  const requireSession = createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    c.set('session', { userId: 'u1' });
    await next();
  });

  const api = defineRootContext('/api/:id').middleware(requireSession);
  // The kind adds `& object` to the vars, as with the inline form.
  expectTypeOf<Flat<typeof api.vars>>().toEqualTypeOf<{ session: Session }>();
  expectTypeOf(api.bindValue).toBeFunction();

  const loadTenant = createMiddleware<ContextEnv<typeof api, { tenantId: string }>>(
    async (c, next) => {
      c.set('tenantId', c.var.session.userId);
      await next();
    },
  );

  const tenant = api.bindValue('n', 'id', () => 1).middleware(loadTenant);
  expectTypeOf<keyof typeof tenant.vars>().toEqualTypeOf<'session' | 'n' | 'tenantId'>();
  expectTypeOf(tenant.bindValue).toBeFunction();

  // @ts-expect-error This middleware reads vars that the context does not have: session
  defineRootContext('/public').middleware(loadTenant);

  const setTenant = createMiddleware<{ Variables: { tenantId: string } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error Cannot redeclare existing var: tenantId
  tenant.middleware(setTenant);

  // A `ContextEnv` middleware in the root array adds only the vars that it sets.
  const root = defineRootContext('/api/:id', [requireSession, loadTenant]);
  expectTypeOf<keyof typeof root.vars>().toEqualTypeOf<'session' | 'tenantId'>();

  // @ts-expect-error This middleware reads vars that the root context does not have: session
  defineRootContext('/api', [loadTenant]);
}

// The deprecated keys are aliases: their types equal the types of the new keys.
{
  type Result = ExtendRouteContextResult<TestContextKind>;

  expectTypeOf<Result['defineRootRoute']>().toEqualTypeOf<Result['defineRootContext']>();
  expectTypeOf<Result['defineChildRoute']>().toEqualTypeOf<Result['defineChildContext']>();
}

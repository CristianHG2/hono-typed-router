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

interface TestContext<TPath extends string, TVars extends object> extends RouteContextBase<
  TestContextKind,
  TPath,
  TVars
> {
  bindValue: <TKey extends string, TValue>(
    key: TKey extends keyof TVars
      ? `Cannot redeclare existing var: "${TKey}". Use another var name, or read "${TKey}" from the context.`
      : TKey,
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

// A root context gets the extension method and keeps the path.
{
  const ctx = defineRootContext('/api/:tenantId', []);
  expectTypeOf(ctx.path).toEqualTypeOf<'/api/:tenantId'>();
  expectTypeOf(ctx.bindValue).toBeFunction();
}

// The extension method adds a typed var, and the returned context keeps `bindValue`.
{
  const ctx = defineRootContext('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => ({
    id,
  }));

  expectTypeOf(ctx.vars).toMatchTypeOf<{ tenant: { id: string } }>();
  expectTypeOf(ctx.bindValue).toBeFunction();
}

// `param` must be a path param of the route.
{
  const ctx = defineRootContext('/api/:tenantId', []);
  // @ts-expect-error 'nope' is not a param of '/api/:tenantId'
  ctx.bindValue('tenant', 'nope', (id) => id);
}

// A redeclared var gives the error string, not a valid key.
{
  const ctx = defineRootContext('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => id);
  // @ts-expect-error 'tenant' is already a var
  ctx.bindValue('tenant', 'tenantId', (id) => id);
}

// An extension stays after `.middleware()`.
{
  const ctx = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  expectTypeOf(ctx.bindValue).toBeFunction();
  expectTypeOf(ctx.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `.middleware()` rejects a redeclared var.
{
  const ctx = defineRootContext('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  // @ts-expect-error `NoRedeclare` rejects the redeclared `user` on the type argument
  ctx.middleware<{
    user: { id: number };
  }>(async (c, next) => {
    // `c` keeps its contextual type and is not an implicit `any`.
    expectTypeOf(c.var.user).toEqualTypeOf<{ id: string } & { id: number }>();
    await next();
  });
}

// A child joins the path, gets the vars, and keeps the extension.
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

// A builder gets its parameter types from the context interface and must return a context.
{
  extendRouteContext<TestContextKind>({
    bindValue: (ctx) => (key, param, produce) => {
      expectTypeOf(key).not.toBeAny();
      expectTypeOf(param).not.toBeAny();
      expectTypeOf(produce).not.toBeAny();
      expectTypeOf(produce).parameters.toEqualTypeOf<[id: string]>();
      // @ts-expect-error `key` is a string, not `any`, so it is not assignable to `0`
      const asZero: 0 = key;
      void asZero;

      return ctx.middleware(async (_c, next) => {
        await next();
      });
    },
  });

  extendRouteContext<TestContextKind>({
    // @ts-expect-error a builder must return a context, not a number
    bindValue: () => () => 42,
  });
}

// The extended `defineChildContext` has the `ParentContext` constraint
{
  // @ts-expect-error `{ path: '/a' }` has no `vars`
  defineChildContext<{ path: '/a' }>();
}

// The value form on an extended context keeps the path, the vars and the builders.
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

// The value form nested inline in a generic call infers the full path on an extended context.
{
  function bind<P extends string>(ctx: TestContext<P, {}>, param: NoInfer<ParamKeys<P>>) {
    return ctx.bindValue('org', param, (id) => ({ id }));
  }

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

  // @ts-expect-error 'nope' is not a param of '/api/orgs/:orgId'
  bind(defineChildContext(root, '/orgs/:orgId'), 'nope');

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

  const bare = defineRootContext('/e');
  expectTypeOf<IsAny<typeof bare.vars>>().toEqualTypeOf<false>();
  expectTypeOf(bare.vars).toEqualTypeOf<{}>();
  expectTypeOf(defineRootContext('/e', []).vars).toEqualTypeOf<{}>();

  const list: MiddlewareHandler[] = [];
  expectTypeOf(defineRootContext('/e', list).vars).toEqualTypeOf<{}>();
  expectTypeOf(defineRootContext('/e', [plainMw] as MiddlewareHandler[]).vars).toEqualTypeOf<{}>();

  expectTypeOf(defineRootContext('/e', [a, b]).vars).toEqualTypeOf<{ a: string } & { b: number }>();

  // A long chain on a folded root keeps each var and the extension, without TS2589.
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

  // @ts-expect-error Cannot redeclare existing var: tenantId. Use another var name, or read tenantId from the context.
  tenant.middleware(setTenant);

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

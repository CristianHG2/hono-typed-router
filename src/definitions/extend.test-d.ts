import { expectTypeOf } from 'expect-type';
import type { ParamKeys } from 'hono/types';
import { extendRouteContext } from './extend';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from './extend';

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

const { defineRootRoute, defineChildRoute } = extendRouteContext<TestContextKind>({
  bindValue: (ctx) => (_key: string, _param: string, _produce: (id: string) => unknown) =>
    ctx.middleware(((_c: unknown, next: () => Promise<void>) => next()) as never),
});

// Root context is augmented with the extension method and preserves the path.
{
  const ctx = defineRootRoute('/api/:tenantId', []);
  expectTypeOf(ctx.path).toEqualTypeOf<'/api/:tenantId'>();
  expectTypeOf(ctx.bindValue).toBeFunction();
}

// The extension method threads path + vars: adds a typed var and re-augments, so
// the returned context still has `bindValue`.
{
  const ctx = defineRootRoute('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => ({
    id,
  }));

  expectTypeOf(ctx.vars).toMatchTypeOf<{ tenant: { id: string } }>();
  expectTypeOf(ctx.bindValue).toBeFunction();
}

// `param` is constrained to the route's path params.
{
  const ctx = defineRootRoute('/api/:tenantId', []);
  // @ts-expect-error — 'nope' is not a param of '/api/:tenantId'
  ctx.bindValue('tenant', 'nope', (id) => id);
}

// Redeclaring an existing var yields the guard string, not a valid key.
{
  const ctx = defineRootRoute('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => id);
  // @ts-expect-error — 'tenant' already exists; key position must reject it
  ctx.bindValue('tenant', 'tenantId', (id) => id);
}

// Extensions survive `.middleware()` chaining.
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(async (_c, next) => {
    await next();
  });

  expectTypeOf(ctx.bindValue).toBeFunction();
  expectTypeOf(ctx.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `.middleware()` still rejects redeclaring an existing var.
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

// Child routes concatenate the path, inherit vars, and stay augmented.
{
  const parent = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  const child = defineChildRoute<typeof parent>()('/things/:id');
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

// The extended `defineChildRoute` shares the `ParentContext` constraint
{
  // @ts-expect-error — `{ path: '/a' }` has no `vars`, so it fails the `ParentContext` constraint
  defineChildRoute<{ path: '/a' }>();
}

// Value form on an extended context: path, vars and builders carry over, and a
// grandchild keeps chaining.
{
  const root = defineRootRoute('/api/:tenantId', []).bindValue('tenant', 'tenantId', (id) => ({
    id,
  }));

  const child = defineChildRoute(root, '/things/:id');
  expectTypeOf(child.path).toEqualTypeOf<'/api/:tenantId/things/:id'>();
  expectTypeOf(child.vars).toMatchTypeOf<{ tenant: { id: string } }>();

  const bound = child.bindValue('thing', 'id', (id) => Number(id));
  expectTypeOf(bound.vars).toMatchTypeOf<{ tenant: { id: string }; thing: number }>();
  expectTypeOf(bound.bindValue).toBeFunction();

  const grandchild = defineChildRoute(bound, '/parts').middleware<{ part: string }>(
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
  const curried = defineChildRoute<typeof root>()('/things/:id');
  expectTypeOf(curried.path).toEqualTypeOf<typeof child.path>();
}

// A root `'/'` parent does not double the slash on an extended context either.
{
  const slashRoot = defineRootRoute('/', []);
  const child = defineChildRoute(slashRoot, '/things');
  expectTypeOf(child.path).toEqualTypeOf<'/things'>();
  expectTypeOf(child.bindValue).toBeFunction();
  expectTypeOf(defineChildRoute<typeof slashRoot>()('/things').path).toEqualTypeOf<'/things'>();
}

// A segment without a leading `/` is joined with one on an extended context too.
{
  const api = defineRootRoute('/api', []);
  expectTypeOf(defineChildRoute(api, 'x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildRoute<typeof api>()('x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(defineChildRoute(defineRootRoute('', []), 'x').path).toEqualTypeOf<'/x'>();
}

// Value form nested inline as an argument of another generic call infers the full path
// on an extended context too.
{
  const bind = <P extends string>(ctx: TestContext<P, {}>, param: NoInfer<ParamKeys<P>>) =>
    ctx.bindValue('org', param, (id) => ({ id }));

  const root = defineRootRoute('/api', []);

  const inline = bind(defineChildRoute(root, '/orgs/:orgId'), 'orgId');
  expectTypeOf(inline.path).toEqualTypeOf<'/api/orgs/:orgId'>();
  expectTypeOf(inline.vars).toMatchTypeOf<{ org: { id: string } }>();
  expectTypeOf(inline.bindValue).toBeFunction();

  const deep = bind(defineChildRoute(defineChildRoute(root, '/orgs/:orgId'), '/teams'), 'orgId');
  expectTypeOf(deep.path).toEqualTypeOf<'/api/orgs/:orgId/teams'>();

  // @ts-expect-error — 'nope' is not a param of '/api/orgs/:orgId'
  bind(defineChildRoute(root, '/orgs/:orgId'), 'nope');

  // The curried form keeps working inline and still returns a callable child builder.
  expectTypeOf(
    bind(defineChildRoute<typeof root>()('/orgs/:orgId'), 'orgId').path,
  ).toEqualTypeOf<'/api/orgs/:orgId'>();
  const childOf = defineChildRoute<typeof root>();
  expectTypeOf(childOf('/x').path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(childOf('/x').bindValue).toBeFunction();
}

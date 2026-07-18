import { expectTypeOf } from 'expect-type';
import type { ParamKeys } from 'hono/types';
import { extendRouteContext } from './extend';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from './extend';

// A representative extension: bind a param-derived value under a new, typed var,
// guarding against redeclaration — exercises path threading (ParamKeys), the vars
// merge, and re-augmentation of the return.
interface TestContext<TPath extends string, TVars extends object>
  extends RouteContextBase<TestContextKind, TPath, TVars> {
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
  const ctx = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );
  expectTypeOf(ctx.bindValue).toBeFunction();
  expectTypeOf(ctx.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `.middleware()` still rejects redeclaring an existing var.
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );
  // @ts-expect-error — redeclaring `user` must produce a guard string, not a valid handler
  ctx.middleware<{ user: { id: number } }>(async (_c, next) => {
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

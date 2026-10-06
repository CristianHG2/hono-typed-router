import { expectTypeOf } from 'expect-type';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { extendRouteContext } from './extend';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from './extend';
import type { BindingsSlot, CheckExtendedMiddlewareFits } from './extend-bindings';
import { defineRootContext as baseRoot } from './define-context';
import type { ParentContext, RouteContext } from './context';

// Keep each `@ts-expect-error` call on one line: the error column differs between TypeScript
// versions, and the curried form reports a second error on the same line.

interface Ctx<TPath extends string, TVars extends object> extends RouteContextBase<
  CtxKind,
  TPath,
  TVars
> {
  tag: <TKey extends string>(
    key: TKey,
  ) => ReaugmentContext<CtxKind, TPath, TVars & Record<TKey, 1>>;
}

interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

const ext = extendRouteContext<CtxKind>({
  tag: (ctx) => (_key: string) => ctx.middleware(async (_c, next) => next()),
});

interface Db {
  query: (sql: string) => string;
}

interface InterfaceBindings {
  DB: Db;
}

const withB = baseRoot<'/api', { s: string }, { DB: Db }>('/api');

const withIB = baseRoot<'/api', { s: string }, InterfaceBindings>('/api');

const kv = createMiddleware<{ Bindings: { KV: string }; Variables: { tenant: string } }>(
  async (_c, next) => next(),
);

const kvOnly = createMiddleware<{ Bindings: { KV: string } }>(async (_c, next) => next());

const a = createMiddleware<{ Variables: { a: 1 } }>(async (_c, next) => next());

// A child of a parent with bindings is an error, in both forms.
{
  // @ts-expect-error the parent has bindings
  ext.defineChildContext(withB, '/x');
  // @ts-expect-error the parent has bindings
  ext.defineChildContext<typeof withB>()('/x');
  // @ts-expect-error the inline parent has bindings
  ext.defineChildContext(ext.defineChildContext(withB, '/a'), '/b');
  // @ts-expect-error the bindings of the parent are an interface
  ext.defineChildContext(withIB, '/x');
  // @ts-expect-error the bindings of the parent are an interface
  ext.defineChildContext<typeof withIB>()('/x');

  expectTypeOf<
    BindingsSlot<{ DB: Db }>
  >().toEqualTypeOf<'Extended contexts do not carry Bindings: use defineChildContext from hono-typed-router for a child of a context with bindings'>();
}

// A middleware that declares `Bindings` is an error in `.middleware()` and in the root array.
{
  const root = ext.defineRootContext('/r/:id');
  // @ts-expect-error the middleware declares `Bindings`
  root.middleware(kv);
  // @ts-expect-error the middleware declares only `Bindings`
  root.middleware(kvOnly);
  // @ts-expect-error the inline handler declares `Bindings`
  root.middleware(async (_c: Context<{ Bindings: { KV: string } }>, next) => next());
  // @ts-expect-error the middleware declares `Bindings`
  ext.defineRootContext('/r', [kv]);
  // @ts-expect-error the second middleware declares `Bindings`
  ext.defineRootContext('/r', [a, kv]);

  expectTypeOf<
    CheckExtendedMiddlewareFits<typeof kv, {}>
  >().toEqualTypeOf<'Extended contexts do not carry Bindings: use the contexts of hono-typed-router for a middleware with Bindings'>();
}

// A parent without bindings is accepted. Curried vars show as `object & V`: use `toMatchTypeOf`.
{
  const empty = baseRoot<'/e', { s: string }, {}>('/e');
  expectTypeOf(ext.defineChildContext(empty, '/x').path).toEqualTypeOf<'/e/x'>();
  expectTypeOf(ext.defineChildContext(empty, '/x').vars).toEqualTypeOf<{ s: string }>();
  expectTypeOf(ext.defineChildContext<typeof empty>()('/x').path).toEqualTypeOf<'/e/x'>();
  expectTypeOf(ext.defineChildContext<typeof empty>()('/x').vars).toMatchTypeOf<{ s: string }>();

  const plainParent = { path: '/p' as const, vars: {} as { a: 1 } };
  expectTypeOf(ext.defineChildContext(plainParent, '/x').path).toEqualTypeOf<'/p/x'>();
  expectTypeOf(ext.defineChildContext(plainParent, '/x').vars).toEqualTypeOf<{ a: 1 }>();
  expectTypeOf(ext.defineChildContext<typeof plainParent>()('/x').path).toEqualTypeOf<'/p/x'>();
  expectTypeOf(ext.defineChildContext<typeof plainParent>()('/x').vars).toMatchTypeOf<{ a: 1 }>();

  const extended = ext.defineRootContext('/r/:id', [a]);
  const nested = ext.defineChildContext(ext.defineChildContext(extended, '/a'), '/b');
  expectTypeOf(nested.path).toEqualTypeOf<'/r/:id/a/b'>();
  expectTypeOf(nested.vars).toEqualTypeOf<{ a: 1 }>();
}

// A parent typed `ParentContext`, or with `object` or `any` bindings, is accepted.
{
  const pc = { path: '/pc', vars: {} } as ParentContext;
  expectTypeOf(ext.defineChildContext(pc, '/x').path).toEqualTypeOf<`${string}/x`>();
  expectTypeOf(ext.defineChildContext(pc, '/x').vars).toEqualTypeOf<object>();
  expectTypeOf(ext.defineChildContext<ParentContext>()('/x').vars).toEqualTypeOf<object>();

  const objB = baseRoot<'/o', {}, object>('/o');
  expectTypeOf(ext.defineChildContext(objB, '/x').path).toEqualTypeOf<'/o/x'>();
  expectTypeOf(ext.defineChildContext<typeof objB>()('/x').path).toEqualTypeOf<'/o/x'>();

  const anyB = baseRoot<'/n', { s: string }, any>('/n');
  expectTypeOf(ext.defineChildContext(anyB, '/x').path).toEqualTypeOf<'/n/x'>();
  expectTypeOf(ext.defineChildContext(anyB, '/x').vars).toEqualTypeOf<{ s: string }>();
  expectTypeOf(ext.defineChildContext<typeof anyB>()('/x').path).toEqualTypeOf<'/n/x'>();
}

// Bindings with only optional keys, or `Record<string, unknown>`, are accepted and dropped.
{
  const optional = baseRoot<'/o', {}, { KV?: string }>('/o');
  expectTypeOf(ext.defineChildContext(optional, '/x').path).toEqualTypeOf<'/o/x'>();
  expectTypeOf(ext.defineChildContext<typeof optional>()('/x').path).toEqualTypeOf<'/o/x'>();

  const loose = baseRoot<'/u', {}, Record<string, unknown>>('/u');
  expectTypeOf(ext.defineChildContext(loose, '/x').path).toEqualTypeOf<'/u/x'>();
}

// Generic helpers compile, because the checks skip the wildcard type of a type parameter.
{
  function valueHelper<B extends object>(p: RouteContext<'/api', {}, B>) {
    return ext.defineChildContext(p, '/x');
  }

  function curriedHelper<B extends object>(_p: RouteContext<'/api', {}, B>) {
    return ext.defineChildContext<RouteContext<'/api', {}, B>>()('/x');
  }

  function parentHelper<P extends ParentContext>(p: P) {
    return ext.defineChildContext(p, '/x');
  }

  function curriedParentHelper<P extends ParentContext>() {
    return ext.defineChildContext<P>()('/x');
  }

  const api = baseRoot('/api');
  expectTypeOf(valueHelper(api).path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(valueHelper(api).vars).toEqualTypeOf<{}>();
  expectTypeOf(curriedHelper(api).path).toEqualTypeOf<'/api/x'>();
  expectTypeOf(parentHelper(api).path).toEqualTypeOf<`${string}/x`>();
  expectTypeOf(curriedParentHelper<typeof api>().path).toEqualTypeOf<'/api/x'>();

  // Limit: the check does not run through a helper. A parent with bindings compiles.
  expectTypeOf(
    valueHelper(baseRoot<'/api', {}, { DB: Db }>('/api')).path,
  ).toEqualTypeOf<'/api/x'>();
}

// A middleware without `Bindings` is accepted in `.middleware()`.
{
  const root = ext.defineRootContext('/r/:id');
  const plain = createMiddleware<{ Variables: { w: string } }>(async (_c, next) => next());
  const untyped = createMiddleware(async (_c, next) => next());
  const anyEnv: MiddlewareHandler<any> = async (_c, next) => next();

  expectTypeOf(root.middleware(plain).vars).toMatchTypeOf<{ w: string }>();
  expectTypeOf(root.middleware(plain).path).toEqualTypeOf<'/r/:id'>();
  expectTypeOf(root.middleware(untyped).tag).toBeFunction();
  expectTypeOf(root.middleware(anyEnv).path).toEqualTypeOf<'/r/:id'>();
  expectTypeOf(ext.defineRootContext('/r', [a]).vars).toEqualTypeOf<{ a: 1 }>();
}

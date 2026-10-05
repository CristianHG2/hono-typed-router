# API reference

All exports come from the package root `hono-typed-router` unless otherwise noted. The words context, route, middleware, route middleware factory, router maker, router, and app have the meanings that the [README glossary](../README.md#concepts) gives.

`defineRootContext` and `defineChildContext` make contexts, not routes. `defineRoute` declares a route.

Every runtime error of the library starts with `hono-typed-router:` and the name of the function that you called, for example `hono-typed-router: makeRouter:`.

## `defineRootContext(path, middlewares?)`

<!-- doc-check: skip -->

```ts
// 1. Explicit or uniform vars and bindings.
function defineRootContext<
  TPath extends string,
  TVars extends object = {},
  TBindings extends object = {},
>(
  path: TPath,
  middlewares?: MiddlewareHandler<RouterEnv<TVars, TBindings>>[],
): RouteContext<TPath, TVars, TBindings>;
// 2. Fold: the intersection of the vars that each middleware sets, and of its bindings.
function defineRootContext<
  TPath extends string,
  TMws extends readonly MiddlewareHandler[],
  _NoExplicitTypeArgs,
  _NoExplicitTypeArgs2,
>(
  path: TPath,
  middlewares?: readonly [...TMws] & CheckRootArray<TMws>,
): RouteContext<TPath, FoldVars<TMws>, FoldBindings<TMws>>;

// The `Env` of the middlewares: `Bindings` only when the bindings are not empty.
type RouterEnv<V extends object, B extends object> = [keyof B] extends [never]
  ? { Variables: V }
  : { Bindings: B; Variables: V };
```

`defineRootRoute` is the deprecated name of `defineRootContext` (removed in 2.0). It holds the same function.

Creates the root `RouteContext`. The `path` is preserved as a literal type, and it becomes the base path of each router that you build from this context. `middlewares` is optional and runs on every request that reaches the routers under this context. Without it, the context has no vars (`{}`).

The vars are inferred from the array. Untyped middlewares (`createMiddleware(handler)` without a type argument, or a plain `MiddlewareHandler`) contribute `{}`, never `any`. Each typed middleware contributes its `Variables`, and the context's vars are their intersection: `defineRootContext('/api', [timing, requestId, log])` gives `RequestIdVars & LogVars`. An empty array or a `MiddlewareHandler[]` variable gives `{}`.

TypeScript tries signature 1 first. Signature 1 accepts a call with explicit type arguments, such as `defineRootContext<'/api', AVars>('/api', [a])`, or with middlewares that all declare the same `Variables`. Signature 2 accepts typed middlewares with different `Variables`. TypeScript can also select signature 2 for an array of one kind: plain handlers, untyped `createMiddleware` handlers, a `MiddlewareHandler[]` variable, or a spread. For these arrays, signature 2 gives the same vars as signature 1.

One, two, or three explicit type arguments always select signature 1. The third and fourth type parameters of signature 2 have no default. Thus, four explicit type arguments select signature 2, for example `defineRootContext<'/api', [typeof a, typeof b], unknown, unknown>('/api', [a, b])`. This call compiles, but it has no use.

The `defineRootContext` of `extendRouteContext` has no bindings slot. One or two explicit type arguments select its signature 1, and three explicit type arguments select its signature 2. Its signature 2 has a fourth type parameter, `_TVars`, which is internal. Four explicit type arguments set the vars to the fourth argument, and nothing checks them. Do not use this form.

The bindings are the Cloudflare `Bindings` of the app: the type of `c.env`. Declare them on the root context. There are two ways:

- Give the bindings as the third type argument: `defineRootContext<'/api', SessionVars, Env['Bindings']>('/api', [auth])`. Each typed middleware in the array must declare the same `Bindings`. Hono's `Context<E>` accepts only an `Env` with the same `Bindings` and `Variables`, not a wider or narrower one. Thus a middleware typed only with `Variables` does not fit, and the call is an error. Add such a middleware with `.middleware()`. Untyped middlewares fit.
- Give middlewares that declare `Bindings` in the array. The bindings of the context are the intersection of their `Bindings`, as for the vars. A middleware that declares only `Bindings` adds no vars.

Without bindings, the context, the app, and `ContextEnv` have the same types as before bindings existed, and `c.env` is `unknown`. A middleware typed with `Bindings` in the root array or in `.middleware()` gives bindings to the context. Then the `Env` of the app is `{ Bindings: B; Variables: V }`, so a handler or a helper typed only `{ Variables: V }` is an error. Type it `{ Bindings: B; Variables: V }`. Children get the bindings of their parent. Bindings do not go up to the parent: Hono's `app.route()` keeps the `Env` of the parent app. Thus declare the bindings on the root context.

This example builds a root context from one untyped and two typed middlewares. `timing` is an untyped `createMiddleware` handler, and `RequestIdVars` and `LogVars` are interfaces:

```ts
const setRequestId = createMiddleware<{ Variables: RequestIdVars }>(
  async function setRequestId(c, next) {
    c.set('requestId', c.req.header('x-request-id') ?? 'none');
    await next();
  },
);

const setLog = createMiddleware<{ Variables: LogVars }>(async function setLog(c, next) {
  c.set('log', (message) => console.info(message));
  await next();
});

const loggedContext = defineRootContext('/logged', [timing, setRequestId, setLog]);
```

The type of `loggedContext.vars` is `RequestIdVars & LogVars`.

In signature 2, a middleware typed `{ Variables: X }` sees only its own vars. In the example, `setLog` cannot read `c.var.requestId`. A `ContextEnv` middleware in the array adds only the vars that it sets. Another middleware of the same array must set the vars that it reads. If not, the error is `This middleware reads vars that the root context does not have: <key>`. The order of the array is not checked. If a middleware reads the vars of a different middleware, prefer `.middleware()`.

Do not write an inline arrow in an array that also has typed middlewares with different `Variables`. On TypeScript 7, the arrow gets no contextual type: `c` is `Context<any>`, so `c.set('foo', 1)` compiles. On TypeScript 5.9, the compiler reports an error in the arrow. Write the handler with `createMiddleware`, or add it with `.middleware()`. Use the array only for handlers that already have a type.

If a middleware in the array has the type `MiddlewareHandler<{ Variables: any }>`, the vars of the context are `any`. Signature 1 accepts this call with `TVars = any`.

Untyped middlewares, such as `cors()` and `logger()` from Hono, or `every()` and `some()` from `hono/combine`, add no vars.

Two middlewares that declare the same var with different types are an error: `Middlewares in the array declare the same var with different types: <keys>`. A narrower type, such as `'x'` and `string`, is also a different type. Two middlewares that declare the same var with the same type are correct.

Two middlewares that declare the same binding with different types are also an error: `Middlewares in the array declare the same binding with different types: <keys>`. The same binding with the same type is correct. `.middleware()` adds the `Bindings` of a middleware without this check.

Signature 2 needs a tuple: an array literal, or an array with `as const`. The element type of an array variable such as `const list = [a, b]` is the union of its middlewares. Thus the fold cannot find which middleware sets which var. If the middlewares of the variable declare different vars, the error is `Pass the middlewares as a tuple literal or as const: an array variable with mixed middlewares has one union element type`. A spread of such a variable, `[...list, c]`, is also an error, but TypeScript shows the error on each element without this message. An array variable of one middleware type, or of untyped middlewares, is correct.

Context paths must use Hono `:param` syntax. This rule applies to `defineRootContext`, to both forms of `defineChildContext`, and to the forms that `extendRouteContext` returns. A path segment that starts with `{` throws a `TypeError` when you define the context:

```text
hono-typed-router: defineRootContext: the path '/api/{id}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/api/:id'.
```

For a child segment, the message starts with `hono-typed-router: defineChildContext:`. A Hono regex param, such as `:id{[0-9]+}`, stays valid. The check runs only at runtime, so the type does not show an error. Only the own `path` of a route config is converted from `{param}` to `:param`.

## `defineChildContext(parent, path)` / `defineChildContext<typeof parent>()(path)`

<!-- doc-check: skip -->

```ts
// Value form
function defineChildContext<
  TPath extends string,
  TParentPath extends string,
  TParentVars extends object,
  TParentBindings extends object = {},
>(
  parent: { path: TParentPath; vars: TParentVars; bindings?: TParentBindings },
  path: TPath,
): RouteContext<`${TParentPath}${TPath}`, TParentVars, TParentBindings>;

// Curried form
function defineChildContext<
  TParentContext extends { path: string; vars: object; bindings?: object },
>(): <TPath extends string>(
  path: TPath,
) => RouteContext<
  `${TParentContext['path']}${TPath}`,
  TParentContext['vars'],
  ContextBindings<TParentContext>
>;
```

`defineChildRoute` is the deprecated name of `defineChildContext` (removed in 2.0). It holds the same function, in both forms.

Creates a child `RouteContext`. Its path type is the path of the parent joined with `path` by `/`. Its vars and its bindings are the vars and the bindings of the parent. The join adds no second slash after a parent that ends in `/` (`'/'` + `'/things'` is `/things`). The join inserts one slash when `path` has no leading `/` (`'/api'` + `'things'` is `/api/things`). Any `{ path; vars }` shape is accepted as the parent, including extended contexts. A shape without `bindings` gives no bindings. Neither form copies the middlewares of the parent. Mounting the router of the child under the router of the parent runs them.

- The value form infers the path and the vars of the parent from the `parent` value. The runtime `path` of the child is `parent.path` joined with `path` by `/`. This is the full path when every ancestor is a root or a value-form child. A curried ancestor contributes only its segment. The relative part stays in `segment` for mounting. The child also records the context that it was created from. Its router can mount under the router of that context. It can also mount under the router of a context derived from it with `.middleware()` (the same lineage, with more middleware). Mounting it under any other context throws a `TypeError` that names both paths (see the mount guard under [`makeRouter`](#makeroutercontext-callback-children)). Examples of other contexts are an ancestor (the parent before a `.middleware()` call), a sibling `.middleware()` branch, and an unrelated context.
- The curried form takes the parent as a type only. So the module of the child needs only an `import type` of the parent. Use it when the module of the parent imports the router of the child (a circular import). There the value form reads an uninitialized parent. The runtime `path` of the child is only `path`, and its type is still the full path. When its router mounts under the router of the parent, `meta.path` is still the full path. The curried form is not deprecated. Nothing checks where you mount it. Under the wrong parent router, the child serves its routes at the wrong URL, and no error tells you this.

```ts
export const thingsContext = defineChildContext<typeof apiContext>()('/things');
```

There are three ways to make a child context:

| Form                                        | Use it when                                                    | Mount check                                    |
| ------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `defineChildContext(parent, path)`          | The parent is in the same file, or in a module without cycle.  | Checked: the wrong parent router throws.       |
| `defineChildContext<typeof parent>()(path)` | The parent module imports the child router (circular import).  | Not checked: the wrong parent gives a bad URL. |
| A builder from `extendRouteContext`         | The same context builder recurs, for example `bindRepository`. | The same as the form of `defineChildContext`.  |

The [project layout](./usage.md#project-layout) of the usage guide uses the curried form in each file.

## `RouteContext<TPath, TVars, TBindings>`

<!-- doc-check: skip -->

```ts
interface RouteContext<TPath extends string, TVars extends object, TBindings extends object = {}> {
  path: TPath;
  vars: TVars;
  bindings: TBindings;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars, TBindings>;
  bind: <TKey extends string, TValue, _TLoaderVars extends TVars = TVars>(
    key: BindKey<TKey, _TLoaderVars>,
    param: BindParam<TPath>,
    load: BindLoader<_TLoaderVars, TValue, TBindings> & CheckBindLoader<TValue>,
  ) => RouteContext<TPath, TVars & { [K in TKey]: NonNullable<Awaited<TValue>> }, TBindings>;
  readonly segment?: string; // internal
}
```

- `path`: the literal path string carried at the type level.
- `vars`: a phantom value of the accumulated variables, that is, a type-only value: it is `{}` at runtime. It is useful only for type inspection.
- `bindings`: a phantom value of the bindings, the type of `c.env`. As for `vars`, it is `{}` at runtime, and it is useful only for type inspection. A context with bindings is not assignable to a `RouteContext` without them, because Hono's `Context<E>` accepts only an `Env` with the same `Bindings` and `Variables`. To accept each context, use the shape `{ path: string; vars: object }`.
- `middlewares`: the runtime list of middlewares that `makeRouter` applies.
- `segment`: internal. It is the path relative to the parent. `makeRouter` uses it as the base path of the router, so that mounting does not prefix the parent path twice. When it is absent, `makeRouter` uses `path`.
- `middleware(handler)`: returns a new context with `handler` appended and the new vars merged into `TVars`. It has three signatures:
  - The inline handler form is `.middleware<NewVars>(handler)`. `c` has `TVars & NewVars`, and `c.env` has `TBindings`. `NewVars` is constrained so that a key already in `TVars` maps to `"Cannot redeclare existing var: <key>"`. So a redeclaration fails on the type argument with a single error, and the handler keeps its contextual types. An inline arrow without a type argument adds `{}`, so give `NewVars` for inline arrows. An explicit type argument always selects this signature.
  - The reusable typed middleware form is `.middleware(middleware)`, with no type argument. A middleware typed `createMiddleware<{ Variables: NewVars }>` reads no vars and sets `NewVars`, so it fits any context. A middleware typed `createMiddleware<ContextEnv<typeof ctx, NewVars>>` reads the vars of `ctx` and sets `NewVars`, so it fits `ctx` and each descendant with more vars. The context gets only the vars that the middleware sets. A set var that `TVars` already has, with the same type or a different type, is `Cannot redeclare existing var: <key>`. A read var that `TVars` does not have is `This middleware reads vars that the context does not have: <key>`. The `Bindings` of the middleware are added to the bindings of the context. Nothing checks them, because the bindings come from the runtime configuration.
  - On a context with bindings, a middleware typed only with `Variables` does not fit the inline signature, because its `Env` has no `Bindings`. A third signature accepts it and gives the same result as on a context without bindings. `c.env` stays typed in the next middlewares.
  - With a `ContextEnv` middleware, `.middleware<NewVars>(middleware)` is an error: the explicit type argument selects the inline signature, which does not accept a `ContextEnv` middleware. The message says that the type is missing the properties `[READS]` and `[SETS]`. Drop the type argument. For a set-only middleware on a context with vars, the explicit form is also an error.
  - A `ContextEnv` middleware that sets a var that the context already has is `Cannot redeclare existing var: <key>`. For example, `ContextEnv<typeof ctx, { count: number }>` on a context that has `count` gives this error.
  - A middleware typed `MiddlewareHandler<{ Variables: any }>` makes the vars of the new context `any`, because the inline signature matches it.
  - A middleware typed `{ Variables: SessionVars & TenantVars }` on a context typed `SessionVars` is correct, and it adds `TenantVars`. The inline signature matches the intersection that contains the vars of the context. On a context with bindings, the third signature matches it in the same way.
  - Untyped middlewares, such as `cors()` and `logger()` from Hono, or `every()` and `some()` from `hono/combine`, add no vars.
  - Known limit: the same middleware applied a second time is not detected. Its `Variables` equal `TVars`, so the inline signature (or the third signature, on a context with bindings) matches it with `NewVars = {}`. The middleware then runs two times. `.middleware<SessionVars>(requireSession)` reports `Cannot redeclare existing var: session` instead. This is the only case where you give a type argument for a reusable middleware.

For an inline arrow function, give the new vars as the type argument:

```ts
interface SessionVars {
  session: { userId: string };
}

const authedContext = defineRootContext('/api').middleware<SessionVars>(
  async function loadSession(c, next) {
    c.set('session', await readSession(c));
    await next();
  },
);

const meContext = defineChildContext(authedContext, '/me');
```

The routes of `meContext` see `c.var.session` with its type.

Build a reusable middleware one time with `createMiddleware` from `hono/factory`. Then give it to more than one context, without a type argument. `.middleware()` gets the new vars from the type of the middleware:

```ts
interface Session {
  userId: string;
  scopes: string[];
}

interface SessionVars {
  session: Session;
}

const requireSession = createMiddleware<{ Variables: SessionVars }>(
  async function requireSession(c, next) {
    const session = await findSession(c.req.header('authorization'));
    if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('session', session);
    await next();
  },
);

const apiContext = defineRootContext('/api').middleware(requireSession);
const adminContext = defineRootContext('/admin').middleware(requireSession);
```

A second application of `requireSession` compiles, and the type argument rejects it:

```ts
apiContext.middleware(requireSession);
apiContext.middleware<SessionVars>(requireSession);
```

The first line compiles and adds no vars. The second line is the error `Cannot redeclare existing var: session`.

Declare each set of vars as a named interface, for example `SessionVars`. Then use the same interface in `createMiddleware<{ Variables: SessionVars }>`, in `.middleware<SessionVars>(handler)`, and in `ContextEnv<typeof context, SessionVars>`. The redeclaration guard also rejects a redeclared interface.

### `.bind(key, param, load)`

<!-- doc-check: skip -->

```ts
type IsOne<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? true : false) : never;
type BindKey<TKey extends string, TVars> = string extends TKey
  ? 'Use a string literal for the key'
  : IsOne<TKey> extends true
    ? TKey extends keyof TVars
      ? `Cannot redeclare existing var: ${TKey}`
      : TKey
    : 'Use one string literal for the key';
type BindParam<TPath extends string> = Exclude<ParamKeys<TPath>, `${string}?`>;
type BindLoader<TVars extends object, TValue, TBindings extends object = {}> = (
  value: string,
  c: Context<RouterEnv<TVars, TBindings>>,
) => TValue;
type BindLoaded<T> = T extends Promise<infer U> ? U : T;
type BindLoadedKind<T> = [0] extends [1 & T] ? 'any' : [T] extends [never] ? 'empty' : 'value';
type CheckBindLoader<TValue> =
  BindLoadedKind<Exclude<BindLoaded<TValue>, null | undefined | void>> extends 'empty'
    ? 'The loader returns no value: return the value of the var, or null when there is none'
    : unknown;
```

Loads a value from a path param and adds it to the context as a new var. It is the built-in form of the most common context builder. Like `.middleware()`, it returns a new context with a new identity, and it appends one middleware to `middlewares`.

- `key` is the name of the new var. It must be one string literal. A `string` key is a compile error: `Use a string literal for the key`. A union key is a compile error: `Use one string literal for the key`. A key that the context already has gives `Cannot redeclare existing var: <key>`.
- `param` is a required param of the context path. An optional `:param?` is not accepted, because a request can match the path without it.
- `load` gets the value of the param and `c`. `c.var` has the vars of the context, and `c.env` has its bindings. `load` returns the value, `null`, `undefined`, or a promise of one of these.
- A loader that can return no value is a compile error: `The loader returns no value: return the value of the var, or null when there is none`. Such a loader returns only `null`, `undefined`, `void`, `never`, or a promise of one of these. Without the check, every request to the route gets a 404.
- The check unwraps one level of `Promise`. It does not check a nested `Promise` or a custom thenable.
- A loader whose return type is a type parameter compiles. For example, a generic wrapper `<T>(find: (id: string) => Promise<T | null>) => context.bind('thing', 'id', (id) => find(id))` compiles. The check does not run through the wrapper: a call of the wrapper with a loader that returns only `null` also compiles.
- The new var has the type `NonNullable<Awaited<TValue>>`.
- The third type parameter is internal. Do not pass it. Do not annotate `c` with other vars. If you annotate `c` with other vars, or pass the third type argument, the loader can read vars that the context does not have. This does not bypass the key check.
- A context with a widened `string` path cannot call `.bind()`, because its params are unknown.

At runtime, the middleware reads `c.req.param(param)` and calls `load`. When `load` gives `null` or `undefined`, the middleware returns `c.notFound()`, so the `app.notFound` handler of the app makes the response. When the param is missing, it also returns `c.notFound()` and does not call `load`. Otherwise it sets the var and calls `next()`. An error from `load` goes to `app.onError`, as an error from any middleware. The name of the middleware function is `bind:<key>`. `inspectRoutes` from `hono/dev` shows it. `showRoutes(app, { verbose: true })` also shows it. Without `verbose`, `showRoutes` prints only the routes.

```ts
const organizationContext = defineChildContext(
  authedContext,
  '/organizations/:organizationId',
).bind('organization', 'organizationId', (id, c) =>
  organizationsRepository.findForMember(id, c.var.session.userId),
);
```

The vars of `organizationContext` are `session` and `organization`. A user who is not a member gets the 404 response of `app.notFound`.

You can chain `.bind()` and `.middleware()`. Each step sees the vars of the steps before it. `.bind()` works on each form of context: a root, a value-form child, a curried child, and an extended context. On an extended context it returns the extended context, with its builders. For a 404 with a custom body, or for a value that does not come from a path param, use `.middleware()`.

## `ContextEnv<TContext, TNewVars>`

<!-- doc-check: skip -->

```ts
// A context without bindings:
type ContextEnv<TContext, TNewVars> = {
  Variables: TContext['vars'] & TNewVars;
  readonly [READS]: TContext['vars']; // type-only
  readonly [SETS]: TNewVars; // type-only
};
// A context with the bindings `B`:
type ContextEnv<TContext, TNewVars> = {
  Bindings: B;
  Variables: TContext['vars'] & TNewVars;
  readonly [READS]: TContext['vars']; // type-only
  readonly [SETS]: TNewVars; // type-only
};
```

The Hono `Env` of a middleware that runs on `TContext` and sets `TNewVars`. Give it to `createMiddleware` from `hono/factory`. The middleware then reads the vars of the context and sets the new vars, all typed. When the context has bindings, the `Env` also has them as `Bindings`, so `c.env` has a type. Without bindings, the `Env` has no `Bindings` key:

```ts
interface TenantVars {
  tenantId: string;
}

const loadTenant = createMiddleware<ContextEnv<typeof apiContext, TenantVars>>(
  async function loadTenant(c, next) {
    c.set('tenantId', `tenant-of-${c.var.session.userId}`);
    await next();
  },
);
const tenantContext = apiContext.middleware(loadTenant); // adds only `tenantId`
```

The type-only `READS` key records the vars that the middleware reads. The type-only `SETS` key records the vars that it sets, `TNewVars`. No runtime value has these keys. With them, `.middleware()` accepts the middleware on `TContext`. It also accepts the middleware on each context with more vars, such as a `.middleware()` descendant or its children. It adds only `TNewVars`. A context without the read vars gives `This middleware reads vars that the context does not have: <key>`. A `TNewVars` key that the context already has gives `Cannot redeclare existing var: <key>`. Do not pass a type argument to `.middleware()` for this middleware. An exact-type assertion on a `ContextEnv` type also sees the `READS` and `SETS` keys.

A chain of `ContextEnv` middlewares, where each middleware is typed from the context of the previous one, type-checks in linear time. Each new context has the vars of the previous context and the `SETS` vars of the middleware.

A `ContextEnv` middleware that sets a var that it also reads gives `Cannot redeclare existing var: <key>`, because the context already has that var.

Nothing checks this fit when the middleware is not passed to `.middleware()`. Two cases are a route middleware factory (a `routeMiddleware` entry, which returns an untyped `MiddlewareHandler`) and the `middleware` key of a route config. There, a `ContextEnv` middleware built for one context type-checks in a router of any context. Its handler sees vars that the context does not set.

## `createRouter(options?)`

<!-- doc-check: skip -->

```ts
function createRouter<const TBase extends BaseRouteConfig = {}>(
  options?: CreateRouterOptions<TBase>,
): MakeRouterFn<TBase>;

interface CreateRouterOptions<TBase extends BaseRouteConfig = {}> {
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  routeDefaults?: TBase;
  /** @deprecated Use `routeDefaults`. */
  base?: TBase;
  transformRoute?: (config: RouteConfig, meta: RouteMeta) => RouteConfig;
}

type BaseRouteConfig = Partial<Omit<RouteConfig, 'method' | 'path'>>;
type RouteMiddlewareFactory = (
  route: RouteConfig,
  meta: RouteMeta,
) => MiddlewareHandler | undefined;

interface RouteMeta {
  readonly path: string;
}
```

Returns a router maker, called `makeRouter` in the examples. Options:

- `routeMiddleware` is the list of route middleware factories. These are `RouteMiddlewareFactory` functions. `defineRoute` calls each one once for each route, with the resolved `RouteConfig` (the `createRoute()` output) and a `RouteMeta`. A route middleware factory returns a middleware, or `undefined` when the route needs none. Then the router attaches nothing for that factory. `app.openapi` attaches the returned middlewares when it registers the route. It uses the exact method + path of the route (`app.on(method, path)`), so other methods on the same path are unaffected. HEAD requests run the middlewares of a GET route. A route that is declared but not registered gets no middleware. When you supply an array, the middlewares run in array order. Each middleware can call `next()` to continue. It can also return a `Response` to short-circuit, as in any Hono middleware. `RouteMiddlewareFactory` returns an untyped `MiddlewareHandler`. So a route middleware factory that returns `createMiddleware<{ Variables: { session: Session } }>(...)` type-checks even when no middleware sets `session`. The library does not check the vars that the middleware of a route middleware factory reads.

```ts
const makeRouter = createRouter({
  routeMiddleware: [
    (route, meta) =>
      async function logHit(_c, next) {
        console.log('hit', route.method, meta.path);
        await next();
      },
  ],
});
```

At request time, `routePath(c)` from `hono/route` also gives the full matched path.

- `routeDefaults` is a partial `RouteConfig` that the router deep-merges into every route declared with it. The pipeline runs in this order. First, the router adds path params to the config of the route. Then it merges `routeDefaults` with the config of the route. When the route declares no params and `routeDefaults.request.params` is set, the router adds the path params after this merge, to the merged params. Then it calls `createRoute()`, computes `meta`, and runs `transformRoute`. Then it runs the route middleware factories (`routeMiddleware`) and returns the result to the caller. Then `app.openapi` attaches the middlewares. The merge rules are:
  - Plain objects recurse key by key (for example `responses[200]` and `request.params`).
  - Arrays are concatenated and deduplicated (for example `security` and `tags`). The merge compares plain objects and arrays by structure. It compares functions, such as middlewares, and other objects, such as class instances and Zod schemas, by reference. One exception exists. A route `security: []` replaces `routeDefaults.security`, so the route opts out of it (OpenAPI semantics). Other empty arrays, such as `tags: []`, are still additive.
  - Zod schemas at the same merge position are unioned with `baseSchema.or(routeSchema)`. This helps when both `routeDefaults` and the route declare, for example, `responses[422]` with different validation-error shapes.
  - For all other leaf conflicts, the value of the route wins.

  The merged shape is reflected in the static return type of `defineRoute()`, so handlers see the combined `responses`/`request` (with `ZodUnion<readonly [default, route]>` at colliding schema slots). For example, a per-route `422` schema combines with the default `422` schema and does not replace it.

```ts
const unauthorizedResponse = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');

const makeRouter = createRouter({
  routeDefaults: { responses: { 401: unauthorizedResponse } },
});

const thingsRouter = makeRouter(thingsContext, ({ app, defineRoute }) => {
  const listThingsRoute = defineRoute('get', { responses: { 200: okResponse } });
  return app.openapi(listThingsRoute, (c) => c.json({ ok: true }, 200));
});
```

The type of `listThingsRoute.responses` has both `200` and `401`.

`routeDefaults.middleware`: at runtime, a route array is concatenated after a default array. When both are tuples (array literals, which `defineRoute` and `createRouter` infer as `const`), the merged type is `[...defaults, ...route]`. So the handler gets the vars of each middleware. When either is a plain array type, the merged type is a union array, and the handler loses the vars of those middlewares. A route single handler replaces the default list at runtime and in the type. So the default middlewares do not run, and no error tells you this. If the default is a single middleware, the route `middleware` replaces it, at runtime and in the type. The merge removes a duplicate function only if it is the same reference. Two middlewares with the same code, made by two calls to one function, both run.

- The accepted configs depend on the options. Three options change a route: `routeMiddleware` with at least one route middleware factory, `routeDefaults`/`base` with at least one key, and `transformRoute`. With one of them, `app.openapi` accepts only the configs that the `defineRoute` of the same router returns. Other configs throw a `TypeError` when the router is built:
  - a `createRoute` config, or a copy such as `{ ...route, hide: true }`: `hono-typed-router: openapi: the GET route at '/api/things' was not declared with the defineRoute() of this router, so its routeMiddleware option does not apply. Declare it with defineRoute(method, config) inside this callback.` The message names the options that change a route, for example `routeDefaults, transformRoute options do not apply`.
  - a config from the `defineRoute` of another router: `hono-typed-router: openapi: the GET route was declared by the defineRoute() of another router. Its route middlewares were built for that router. Declare it with defineRoute(method, config) inside this callback.` A router without options also throws this error for a config of another router that has route middlewares.

  Set `hide` and the other route keys in `defineRoute`. A `createRouter()` without options, or with options that change no route (`routeDefaults: {}`, `routeMiddleware: []`), accepts `createRoute` configs. The duplicate check also reads these configs (see [`makeRouter`](#makeroutercontext-callback-children)).

  The callback must return the `app` that it received, or nothing. A route registered on another `OpenAPIHono`, for example `app.basePath('/x')` or one that the callback creates, does not get its route middlewares. If the callback returns such an app and a declared route has route middlewares that `openapi` did not attach, the router throws a `TypeError`: `hono-typed-router: makeRouter: the GET route at '/api/things' has route middlewares that were not attached, because the callback returned a different app. Return the app that the callback received, or register the routes on it.` For the children of `mountRouter`, the message starts with `hono-typed-router: mountRouter:`. A returned app is accepted when no declared route has route middlewares, or when every one was attached.

- `base` is the deprecated name of `routeDefaults`, removed in 2.0. It infers and merges the same way. If you set both, the router uses `routeDefaults` and ignores `base`.

- `transformRoute` is a runtime-only `(config, meta) => RouteConfig` hook. It runs immediately after `createRoute()` and after the `routeDefaults` merge. It runs before the route middleware factories receive the config and before the router returns the config to the caller. The hook does not affect the static return type of `defineRoute()`. It is an escape hatch for changes to all routes, for example auto-tagging, an `operationId`, or normalized security entries. Return `{ ...config, ... }`. A hook that builds a new object without spreading `config` drops its keys. This includes the `middleware` of the route, whose middlewares then do not run.

```ts
const makeRouter = createRouter({
  transformRoute: (route) => ({
    ...route,
    tags: [...(route.tags ?? []), route.method === 'get' ? 'read' : 'write'],
  }),
});
```

If you call the router of a curried child directly, for example `thingByIdRouter()` in a test, `meta.path` starts at the segment of the child (`/:id`). Then an `operationId` derived from `meta.path` is different. To keep it stable, give the route its own `operationId`, for example `operationId: 'getThing'`, and keep it in the hook.

- `RouteMeta` is the second argument of route middleware factories and of `transformRoute`. `meta.path` is the full mount path of the router joined with the relative path of the route, in Hono `:param` syntax. A route path of `'/'` gives the mount path, and a root defined as `''` gives `'/'`. The router computes it before `transformRoute`. It does not change if the hook rewrites `config.path`. A mounted router always gets the full URL path in `meta.path`. Its parent passes its own full path, and the router joins it with its segment. This is true for value-form children, curried children, and value-form children of a curried parent. A router called directly, with no parent, uses the runtime `path` of its context. That is the full path for a root. For a value-form child, it is the full path only when every ancestor is a root or a value-form child. A value-form child with a curried ancestor gets a partial path that starts at the segment of that ancestor (for example `/things/sub`). A curried child gets only its segment. `config.path` itself stays relative (usually `'/'`).

## `BaseRouteConfig` and `DeepMerge<A, B>`

<!-- doc-check: skip -->

```ts
type BaseRouteConfig = Partial<Omit<RouteConfig, 'method' | 'path'>>;
type DeepMerge<A, B> = /* see source */;
```

Exported as type-only helpers. `DeepMerge` is the type-level equivalent of the runtime merge:

- It produces `ZodUnion<readonly [A, B]>` when both sides are `ZodType`.
- It merges two arrays into an element union, `(A[number] | B[number])[]`. It does not produce a tuple, because the runtime deduplicates. One exception exists. The `middleware` key with a tuple on both sides gives `[...A, ...B]`, so the handler gets the vars of each middleware.
- It recurses through plain objects. When the route type of a key includes `undefined`, the result also includes the base type and `undefined`. The runtime keeps the base value for an absent key and copies an explicit `undefined`.
- In all other cases, the second argument wins.

Known limitation: optional (`?`) modifiers are not kept through the merge. When `routeDefaults` has no keys, `defineRoute()` returns the route config type unchanged. Use `DeepMerge` to type external wrappers that build configs from the same `routeDefaults`.

## `makeRouter(context, callback, children)`

<!-- doc-check: skip -->

```ts
type ChildRouter = () => OpenAPIHono<any, any, any>;

type RouterCallback<TPath, TVars, TBindings, TBase, TResult> = (options: {
  app: OpenAPIHono<RouterEnv<TVars, TBindings>>;
  /** @deprecated Use app. Removed in 2.0. */
  router: OpenAPIHono<RouterEnv<TVars, TBindings>>;
  defineRoute: MakeRouteFn<TPath, TBase>;
  /** @deprecated Use defineRoute. Removed in 2.0. */
  route: MakeRouteFn<TPath, TBase>;
}) => TResult;

// Without children: the callback can return anything, or nothing.
function makeRouter<TPath, TVars, TCallbackResult, TBindings = {}>(
  context: RouteContext<TPath, TVars, TBindings>,
  callback: RouterCallback<TPath, TVars, TBindings, TBase, TCallbackResult | void> &
    CheckCallbackResult<TCallbackResult>,
): () => FactoryReturn<TCallbackResult, OpenAPIHono<RouterEnv<TVars, TBindings>>>;

// With children: the callback returns the app or nothing.
function makeRouter<
  TPath,
  TVars,
  TCallbackResult extends OpenAPIHono<any, any, any> | void,
  const TChildren extends readonly ChildRouter[],
  TBindings = {},
>(
  context: RouteContext<TPath, TVars, TBindings>,
  callback: RouterCallback<TPath, TVars, TBindings, TBase, TCallbackResult>,
  children: (TChildren & CheckChildren<TChildren>) | undefined,
): () => WithChildSchemas<
  FactoryReturn<TCallbackResult, OpenAPIHono<RouterEnv<TVars, TBindings>>>,
  ChildSchema<TChildren[number]>
>;
```

Parameters:

- `context`: the context (root or child) that gives the router its path, vars, and middlewares.
- `callback`: the callback of `makeRouter`. It receives `{ app, defineRoute }` and returns the app (usually the `.openapi()` chain). If it returns nothing, the children mount on `app`. `router` is the deprecated name of `app` (removed in 2.0). It holds the same instance. `route` is the deprecated name of `defineRoute`.
- `children`: an array of routers, built with the same router maker or with a different one. They mount in array order on the returned router. In this overload the parameter is required, and an explicit `undefined` is allowed. A call with two arguments, `makeRouter(context, callback)`, is the overload without children.

Without children, a callback that returns an `OpenAPIHono` app with no typed routes is a compile error: `The callback returns an app with no typed routes. Return the .openapi() chain, or return nothing.` This occurs when the callback registers the routes in separate statements and then returns `app`. Return the `.openapi()` chain, or return nothing. With children, `({ app }) => app` is correct, and the check does not run.

Returns a router, a function `() => OpenAPIHono`. Call it to build the app, or pass it in a parent's `children`. Its type carries the children's routes, so `testClient` and `hc` see them.

Children mount in array order, and Hono matches in registration order. So a child at `/:id` mounted before a child at `/stats` gets the requests to `/stats`. Put the children with literal segments first. When the router runs, it throws a `TypeError` for this order:

```text
hono-typed-router: makeRouter: the child '/:id' is mounted before '/stats'. Hono matches in registration order, so '/:id' gets the requests to GET '/api/stats'. Put children with literal segments first.
```

The router accepts this order only when two conditions are true. First, the whole subtree of the param child has no middleware of its own: no `.bind()`, no `.middleware()`, and no `app.use()` in a callback. The subtree also has no raw routes, such as `app.get(...)`. Second, no route of that subtree overlaps a route of the sibling with the same method. The overlap test treats the param segment as a match for the segment of the sibling. `HEAD` counts as `GET`. `ALL` (from `app.all()` or `app.use()`) counts as every method. The error names the sibling route that the param child gets, such as `GET '/api/stats'`. A middleware or a raw route in the subtree of the param child makes every route of the sibling collide. This is true also when the paths do not overlap. If both conditions are true, no request of the sibling runs code of the param child. The check compares siblings only. A child at `/:id` before a child at `/:id/settings` is not checked.

The router registers the middleware of a bound context for every path under its segment. A sibling router mounted after it, under the same param segment, also runs the loader, and no error tells you this. Mount such a sibling first.

The `children` array comes after the callback, so a long callback hides it. For readability, build each child router in its own module or `const` and pass the array by name with `as const`:

```ts
const statsRouter = makeRouter(statsContext, ({ app, defineRoute }) =>
  app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
    c.json({ ok: true }, 200),
  ),
);
const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) =>
  app.openapi(defineRoute('delete', { responses: { 200: okResponse } }), (c) =>
    c.json({ ok: true }, 200),
  ),
);

const thingsChildren = [statsRouter, thingByIdRouter] as const;
const thingsRouter = makeRouter(thingsContext, () => {}, thingsChildren);
```

Without `as const`, the array of two different routers gets one element type, and the type can lose the routes of a child. A children array in a plain variable is a compile error (`CheckChildren`): `Pass children inline or as const: a children array variable has one element type, and the app type can lose the routes of some children`. Known false positives are a one-element array variable and an array whose children have one type. Examples are `routers.map(() => r)`, `(typeof r)[]`, and routers with identical types. Pass them inline, or type the variable as `ChildRouter[]`. The app type then has no routes of those children. A generic helper that forwards children is also rejected, for example `const forward = <T extends ChildRouter[]>(kids?: T) => makeRouter(api, ({ app }) => app, kids)`. Write `kids as ChildRouter[] | undefined` in the call, the opt-out type. The check costs about 23,000 type instantiations for an array variable with a union of 50 children.

A `makeRouter(...)` call can also be written inline inside another call's `children` array. The outer router's type then carries the routes of the inner router and of its children.

`ChildRouter` is exported. `CheckChildren`, `WithChildSchemas` and `ChildSchema` are internal names (see `src/router/children.ts`). They are not exported.

If the callback returns nothing (or `null`/`undefined` on some path), the app is the `app` object that the callback received. Children are still mounted on it. When `children` are passed, the callback must return the app or nothing.

The app's type includes the routes of the children, so `hc` and `testClient` see them. Pass `children` inline or `as const`. An array held in a variable typed `ChildRouter[]` (or `(() => OpenAPIHono<any, any, any>)[]`) compiles, but it drops the schemas.

If two routes declare the same method and full path, the client type for that path becomes `never`. It can also be a false merge of the two bodies. The router intersects the schemas, as Hono's `route()` does. For this reason, the router throws a `TypeError` when it runs:

```text
hono-typed-router: makeRouter: two children declare GET '/api/things/:id'. The client type of that path can become never. Declare each method and path once.
```

Other forms of the message are `the callback and a child both declare GET '/api/things/:id'` and `the callback declares GET '/api' twice`. Another form is `two children declare GET '/a/:id' and GET '/a/:x'`. It names two paths that differ only in the names of their params. Hono gives every request to the first route, so such paths are duplicates. A param regex (`:id{[0-9]+}`) and the optional marker `?` count, so paths that differ in them are not duplicates. `/things` and `/things/` are different routes, so they are not duplicates. The check reads the routes that `app.openapi` registers. On a router maker without options, or with options that change no route, these include `createRoute` configs and configs without route middlewares from the `defineRoute` of another router. Two configs with the same method and path in one callback are a duplicate. The same config that the callback registers two times is one route. A route that `app.openapi` does not register is not checked. Examples are a raw `app.get()` route and a route on `app.basePath(...)`.

A root context without routes of its own only mounts its children. These two lines give the same app:

```ts
const app = makeRouter(apiContext, ({ app }) => app, [thingsRouter])();
const sameApp = mountRouter(apiContext, [thingsRouter]);
```

`TBase` is threaded from `createRouter`'s options, so `defineRoute()`'s return type reflects the configured `routeDefaults`.

The router's base path is `context.segment ?? context.path`: the context's path relative to its parent.

Returns a router: a function that builds and returns the app when you invoke it. The deferred invocation lets a parent mount children without ordering issues. Its public type takes no arguments, so call it as `childRouter()`. At runtime, a parent calls each child router with an internal argument that holds the full mount path of the parent. The child uses it only to compute `meta.path`. If you call a router directly, or wrap it as `() => childRouter()` in `children`, it gets no argument. It then uses the runtime `path` of its context for `meta.path`, as described under `RouteMeta`. Routing is the same in both cases.

The same internal argument also identifies the parent's context. A value-form child's router can be mounted under the context that it was defined from, or under a `.middleware()` descendant of that context. Under any other context, the child router throws a `TypeError`:

```text
hono-typed-router: makeRouter: the child context '/api/things' was defined under the context at '/api', but its router is mounted under the context at '/admin'. Mount the router of a child under the router of the context that it was defined from, or of a .middleware() descendant of that context.
```

When the mount path is the same as the path of the parent, the message says `mounted under an ancestor or an unrelated context with the same path '/api'` and gives examples. For the children of `mountRouter`, the message starts with `hono-typed-router: mountRouter:`. Without this check, a child defined under an auth-protected parent and mounted under another parent serves its routes without the middlewares of the parent. A `.middleware()` descendant runs all of the middlewares of the parent plus its own, so mounting under it is allowed. Curried children, routers called directly, and routers wrapped as `() => childRouter()` are not checked.

`defineRoute` is inside the callback for one reason. The full path of a router is known only when the router runs under its parent. `defineRoute` needs this path for the path params, for `meta.path`, for `transformRoute`, and for the route middleware factories. For this reason, the callback of `makeRouter` gives `defineRoute`. A `createRoute` config has none of these features. Only a router maker without options accepts a `createRoute` config.

The `defineRoute(method, config)` argument supplied to the callback (`route` is a deprecated alias that holds the same function):

- Adds `request.params` from the path where the app is served (see the path params below).
- Calls `createRoute({ method, path: '/', ...config })` so that the route is registered at the context's base path.
- If `createRouter` was given `routeMiddleware`, calls each route middleware factory with the config and its `RouteMeta`, and records the resulting middlewares with the config.
- Returns the resolved `RouteConfig` for use with `app.openapi(config, handler)`.

`app.openapi(config, handler)` attaches the recorded middlewares to the method + path of the route when it registers the route. It attaches them before the validators and the handler of the route. A route that is declared but not registered gets no middleware. A middleware that the callback adds with `app.use()` before the `app.openapi` call runs before the route middlewares. A config registered twice gets its middlewares once. See the accepted configs under `createRouter` for the configs that `openapi` accepts.

`config` is inferred as `const`: an array stays a tuple, and literal values such as `description` and `tags` keep their literal types in the config type.

The router builds `request.params` from the context path as follows:

- Each `:param` and `:param{regex}` is `z.string()`.
- `:id?` is not added. Read an optional param with `c.req.param('id')`. OpenAPI cannot show an optional path parameter, and `required: false` is not valid for one.
- The params of a sub-path in `config.path` are also added. The params of a path that `transformRoute` sets are not added.
- With no params declared, the route gets a `z.object` of these strings.
- A declared `z.object` keeps its keys and their types (for example `z.coerce.number()`). The missing path params are added with `safeExtend`. Its own config, such as `.strict()`, and its refinements are kept (zod 4.1 or later).
- With no params declared on the route, a `z.object` in `routeDefaults.request.params` gets the missing path params after the merge.
- A declared key that the path does not have is a compile error: `The path '/api/things/:id' has no param named 'thingId'`. A widened `string` path is not checked.
- another params schema (not a `z.object`), or a path without required params, owns the params, and the config is not changed.

The type uses the full path of the context. At runtime the params come from the path where the app is served. When a parent mounts the router, that is the full path. When you call a child router directly (for example in a test), it is only the own segment of the context. The OpenAPI document lists each path parameter. The handler reads the params with `c.req.valid('param')`, or as `param` in [`handle`](#handlec-fn-arms).

```ts
const thingByIdContext = defineChildContext(apiContext, '/things/:id');

const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
  const getThingRoute = defineRoute('get', {
    request: { params: z.object({ id: z.coerce.number() }) },
    responses: { 200: okResponse },
  });

  return app.openapi(getThingRoute, (c) => {
    const { id } = c.req.valid('param');
    return c.json({ ok: id > 0 }, 200);
  });
});
```

The `id` param comes from the context path. The declared `z.object` changes its type to `number`.

`config` can set the native `middleware` key of `@hono/zod-openapi` (a handler or a list). `app.openapi()` registers those middlewares with the route. They run after the middlewares of the route middleware factories and before the validators. The README section [Which middleware to use](../README.md#which-middleware-to-use) gives the full run order. On a validation failure, every middleware has run and the handler does not. The middlewares of the route also run for HEAD on a GET route. They show their function names in `showRoutes(app, { verbose: true })`. They are visible to route middleware factories as `route.middleware`. They do not change the OpenAPI document. For typing, the handler sees the vars that the middlewares set, plus the context vars. This holds for a single handler and for an array literal (`middleware: [a, b]`), which `defineRoute` keeps as a tuple without `as const`. A variable with a plain array type (`MiddlewareHandler[]`) is not a tuple. zod-openapi folds it to `Env`, and the vars silently disappear from `c.var`. The middlewares still run.

## `mountRouter(context, children)`

<!-- doc-check: skip -->

```ts
function mountRouter<
  TPath extends string,
  TVars extends object,
  const TChildren extends readonly ChildRouter[],
  TBindings extends object = {},
>(
  context: RouteContext<TPath, TVars, TBindings>,
  children: TChildren & CheckChildren<TChildren>,
): WithChildSchemas<OpenAPIHono<RouterEnv<TVars, TBindings>>, ChildSchema<TChildren[number]>>;
```

Builds a router that declares no routes and only mounts children, and returns the app. Use it for the root app:

```ts
const makeRouter = createRouter();

const thingsRouter = makeRouter(defineChildContext(root, '/things'), ({ app, defineRoute }) =>
  app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
    c.json({ ok: true }, 200),
  ),
);

const app = mountRouter(root, [thingsRouter]);
```

`makeRouter(context, ({ app }) => app, children)()` is the long form. `mountRouter` uses the same code path and gives the same type. The router applies the context's middlewares and uses the context's base path. It mounts each child with the same internal argument as `makeRouter`, so the mount guard and the full `meta.path` work the same.

`mountRouter` takes no `createRouter` options, because its router declares no routes. Each child keeps the options of the router maker that built it. Use `makeRouter` when the root declares routes of its own.

`mountRouter` returns an app, not a router, so you cannot pass its result in `children`. For a node between the root and the leaves that declares no routes, use `makeRouter(context, () => {}, children)`. `children` is required. Pass the array inline or `as const`, as for `makeRouter`.

## `createScopeMiddleware(options)` / `createScopeMiddleware(context, options)` _(from `hono-typed-router/scopes`)_

<!-- doc-check: skip -->

```ts
function createScopeMiddleware<TVars extends object = {}, TBindings extends object = {}>(
  options: ScopeMiddlewareOptions<TVars, TBindings>,
): RouteMiddlewareFactory;
function createScopeMiddleware<TVars extends object, TBindings extends object = {}>(
  context: { readonly vars: TVars; readonly bindings?: TBindings },
  options: ScopeMiddlewareOptions<TVars, TBindings>,
): RouteMiddlewareFactory;

interface ScopeMiddlewareOptions<TVars extends object = {}, TBindings extends object = {}> {
  resolve: (
    c: Context<RouterEnv<TVars, TBindings>>,
  ) => readonly string[] | Promise<readonly string[]>;
  onForbidden?: (
    missingScopes: string[],
    c: Context<RouterEnv<TVars, TBindings>>,
  ) => unknown | Promise<unknown>;
}
```

`TVars` types `c.var` in `resolve` and `onForbidden`, and `TBindings` types `c.env`. The context form takes both from the context. Give it as a type argument, `createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes })`. Or pass a context, `createScopeMiddleware(apiContext, { resolve })`. Only the type of the context is used. Without either, `c.var` has no vars, so `c.var.session` is a compile error. The router does not check the vars against the contexts of the routes. Give the vars that the context middlewares set before the route middleware runs.

It returns a route middleware factory, not a middleware. Pass it to `createRouter({ routeMiddleware })`, not to `.middleware()`. It extracts the required scopes from `route.security`, flattens them across schemes, and de-duplicates them. If `resolve(c)` does not cover every required scope, it responds with 403. The body is either the default body (`{ error: 'E_FORBIDDEN', message: 'Missing <scopes> scope(s)' }`) or the value that `onForbidden` returns.

If a route has no scopes in `security`, the route middleware factory returns `undefined`. So the route gets no scope middleware, and `showRoutes` lists none. A route with scopes gets a middleware named `requireScopes:<scopes>`.

## Schema helpers

```ts
jsonResponse(schema, description); // { description, content: { 'application/json': { schema } } }
jsonBody(schema, description); // same shape, for request bodies
jsonRequest(schema, description); // { body: { ...jsonBody(...), required: true } }
emptyResponse(description); // { description }
```

These are thin shape-builders for `@hono/zod-openapi` `createRoute()` configs. All four take positional arguments: `(schema, description)`, or `(description)` for `emptyResponse`.

`jsonRequest` marks the body as required (`required: true`). As a result, the validator gets `{}` for a request without a JSON body. If the schema has required fields, the validation fails with a 400, and the request does not reach the handler. `jsonBody` is the building block without `required`. For an optional body, use `{ body: jsonBody(schema, description) }`. The 0.x names `makeHonoResponse`, `makeHonoJsonBody`, `makeHonoJsonRequest` and `makeHonoNoContentResponse` are deprecated aliases of these four (removed in 2.0).

## Error handling

### `handle(c, fn, arms?)`

<!-- doc-check: skip -->

```ts
function handle<I extends Input, R, const A extends ReadonlyArray<AnyArm> = readonly []>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<R>,
  arms?: A,
): Promise<R | ArmsResponse<A>>;

type ValidatedProxy<I extends Input> = {
  [K in ProxyKeys<I>]: InputToDataByTarget<I['out'], K>;
};
// ProxyKeys<I>: the validation targets that the route declares. A general `Input` keeps all targets.
// The default `Input` of a bare `Context` (`{}`) gives no keys.
```

Runs a route handler body and returns a plain promise. `fn` receives a `ValidatedProxy`. This is a destructurable view over the validated inputs of the request. The targets are `param`, `query`, `json`, `form`, `header`, and `cookie`. Each one is typed from the `Input` of the route. The view has only the targets that the route declares. So reading an undeclared target (for example `json` on a route without a body) is a compile error. A route at a path with required params always has `param`. A `Context` with the default `Input`, such as a bare `Context`, gives a proxy with no keys. Use the context that `app.openapi` gives to the handler. The proxy reads every target from `c.req.valid` lazily and caches it. It never reads untouched targets, and it reads a touched target once.

With `arms`, `handleErrors` dispatches a thrown `Error`, and the result type is widened with the response of each arm (`ArmsResponse<A>`). You return that widened value to `app.openapi(...)`. So an arm that emits a status that the route did not declare in `responses` is a compile error. Without `arms`, the return type is exactly `Promise<R>`, and a thrown error rejects the promise.

### `handler(c, fn)` _(deprecated)_

<!-- doc-check: skip -->

```ts
function handler<I extends Input, TResponse>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<TResponse>,
): HandlerInvocation<TResponse>;
```

Deprecated, removed in 2.0: use `handle(c, fn)` or `handle(c, fn, arms)`. Returns a lazy thenable over `handle(c, fn)`. The body runs at most once, whether awaited directly or via `.errors([...])`, in any order.

### `HandlerInvocation<TResponse>` _(deprecated)_

<!-- doc-check: skip -->

```ts
type HandlerInvocation<TResponse> = Promise<TResponse> &
  Readonly<{
    errors: <const TArms extends ReadonlyArray<AnyArm>>(
      arms: TArms,
    ) => Promise<TResponse | ArmsResponse<TArms>>;
  }>;
```

The awaitable result of the deprecated `handler`. On its own it settles to `TResponse`. Calling `.errors(arms)` runs the body under `handleErrors` and widens the result with the response type of each arm. You return that widened value to `app.openapi(...)`. So an arm that emits a status that the route did not declare in `responses` is a compile error. The OpenAPI contract and the runtime handler cannot drift apart.

### `onError(ctor, handle)`

<!-- doc-check: skip -->

```ts
function onError<TErr extends Error, TResult>(
  ctor: new (...args: any[]) => TErr,
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>,
): ErrorArm<TErr, TResult>;
```

Declares an error arm. It matches errors that are `instanceof ctor`, then runs `handle`. `TResult` is inferred from the return of the handler, so the arm carries the exact response type that it produces. An example is the `TypedResponse` of `c.json(body, status)`. Return `rethrow()` to decline and fall through to the next arm.

`on` is the deprecated 0.x name of `onError` (removed in 2.0).

### `matchErrors(errors, handlers)`

<!-- doc-check: skip -->

```ts
type ErrorCtor = new (...args: any[]) => Error;

// The string-literal `_tag` of the class's instances, else their string-literal `name`, else never.
type ErrorTag<C extends ErrorCtor> = /* ... */;

type MatchHandlers<TCtors extends readonly ErrorCtor[]> = {
  readonly [C in TCtors[number] as ErrorTag<C>]: (err: InstanceType<C>, c: Context) => any;
};

function matchErrors<
  const TCtors extends readonly ErrorCtor[],
  THandlers extends MatchHandlers<TCtors> /* & no keys outside the tags */,
>(
  errors: TCtors, // each class must have a unique literal tag
  handlers: THandlers,
): { readonly [I in keyof TCtors]: ErrorArm<InstanceType<TCtors[I]>, /* handler's response */> };
```

Declares one error arm per class, with an exhaustive handler map keyed by tag. It returns an arm tuple, so it goes where an arm list goes. Three examples are `handle(c, fn, matchErrors(...))`, `handleErrors(body, matchErrors(...), c)`, and a spread next to other arms, `[...matchErrors(...), onError(Error, ...)]`. Each element has the same type as the equivalent `onError(Class, handler)` arm, so the return type of `handle` is the same. A handler that emits a status that the route did not declare is a compile error inside `app.openapi`.

```ts
class CartNotFound extends Error {
  readonly _tag = 'CartNotFound' as const;
}

class OutOfStock extends Error {
  readonly _tag = 'OutOfStock' as const;
  constructor(readonly sku: string) {
    super();
  }
}

class Legacy extends Error {
  override readonly name = 'Legacy' as const;
}

app.openapi(checkout, (c) =>
  handle(
    c,
    async ({ param }) => c.json(await checkoutCart(param.id), 201),
    matchErrors([CartNotFound, OutOfStock, Legacy], {
      CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
      OutOfStock: (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
      Legacy: () => rethrow(),
    }),
  ),
);
```

The key of a class is `ErrorTag<Class>`. It is the first of these that exists:

1. The string-literal type of the `_tag` of its instances, if there is one.
2. Otherwise the string-literal type of their `name`. Declare it as `override readonly name = 'X' as const`. A `name` typed `string` does not count. `Error.prototype.name` is typed `string`, and so is `this.name = 'X'` in a constructor.
3. else the class is rejected in the `errors` list with `Error class at index N needs a literal _tag or name`.

Two classes with the same tag are also rejected (`Error class at index N shares the tag "X" with another class`).

`handlers` must have a key for every class, and no other key. A missing key is reported as a missing property. An extra key is reported as `"<Key>" is not the tag of a listed class. The tags are: <tags>`. TypeScript can also report the parameters of that handler as implicit `any`. Each handler receives the instance of its own class (`e.sku` above) and the `Context`. It returns a response or `rethrow()`, sync or async, as in `onError`. The `Context` of a handler (`ec` above) is not typed with the vars of the route, so read route vars from the outer `c`. To reuse arms, put them in a constant, for example `thingNotFoundArms` in the [complete example](./usage.md#complete-example).

A thrown `Error` that is an instance of any listed class (by `instanceof`) is handled by the handler keyed by its runtime tag. The tag is its `_tag` if `handlers` has that key, else its `name`. The order of the list does not matter. The class list only decides whether the tuple handles the error, and the tag picks the handler. An unlisted subclass that inherits the tag of a listed class goes to the handler of that class. A `rethrow()` passes the error to the arms after the tuple. Non-`Error` throws bypass the arms.

Reused tags are a hazard. TypeScript rejects a subclass that changes an inherited literal `_tag` or `name`. It does not reject a subclass of a `name`-tagged class that _adds_ a `_tag`. If that `_tag` equals the tag of another listed class, the error goes to the handler of that other class. The parameter of that handler is typed as that class, although the error is not an instance of it. Do not reuse a tag across unrelated classes.

A handler that returns `rethrow()` passes the error past the rest of the tuple to the next arm after it. An example is an `onError(Error, ...)` spread after the tuple. If no arm handles it, the original error is rethrown.

Take an error that is an instance of a listed class, where neither its `_tag` nor its `name` names a handler. An example is a `_tag` declared with `declare` and never set. The arm then passes as if it returned `rethrow()`. A later arm can handle the error. Otherwise the original error is rethrown. An error thrown inside a handler propagates and skips the later arms. If it is an `Error` without a `cause`, the original error becomes its `cause`, so the error log shows both errors.

`onError` is the primitive `matchErrors` is built on. Use it directly for a single arm, for arms shared across routes, or to match a class that has no literal tag.

The client types that `hc` and `testClient` see come from the `responses` of the route, not from the handler. TypeScript checks `handle` and its arms against `responses`, so the two agree.

### `rethrow()`

<!-- doc-check: skip -->

```ts
type Rethrow = typeof RETHROW;
function rethrow(): Rethrow;
```

`rethrow()` returns the rethrow sentinel (compared by identity). An arm that returns it defers to the next matching arm. If none matches, the original error is rethrown. `Rethrow` responses never leak into the widened return type.

The `RETHROW` export is the same sentinel. It is deprecated, and version 2.0 removes it. Return `rethrow()` from the arm instead. The `Rethrow` type stays.

### `handleErrors(body, arms, c)`

<!-- doc-check: skip -->

```ts
function handleErrors<TBody, const TArms extends ReadonlyArray<AnyArm>>(
  body: () => Promise<TBody>,
  arms: TArms,
  c: Context,
): Promise<TBody | ArmsResponse<TArms>>;
```

`ArmsResponse<TArms>` is the union of each arm's awaited response minus the
`Rethrow` sentinel. It is the same type `handle(c, fn, arms)` widens with.

The dispatch behind `handle(c, fn, arms)`. Use it on its own when you do not need the input proxy. It runs `body()`. If `body()` throws an `Error`, the first arm whose `ctor` matches (by `instanceof`) handles it. The arms are tried in order, and an arm that returns `rethrow()` falls through. Non-`Error` throws bypass the arms. The return type is `TBody` widened with the response of each arm (awaited, minus the `Rethrow` sentinel). If an arm handler throws an `Error` that has no `cause`, the original error becomes its `cause`. A frozen error, or an error whose `cause` cannot be set, is rethrown unchanged. A module-level singleton error keeps the `cause` of its first throw.

### `genericErrorHandler(status)`

<!-- doc-check: skip -->

```ts
function genericErrorHandler<T extends ContentfulStatusCode>(
  statusCode: T,
): (err: Error, c: Context) => TypedResponse<{ message: string }, T, 'json'>;
```

Convenience arm handler that responds with `{ message: err.message }` at the given status. Compose with `onError`: `onError(SomeError, genericErrorHandler(409))`.

## Extending the `define[x]` context

### `extendRouteContext<K>(builders)`

<!-- doc-check: skip -->

```ts
function extendRouteContext<K extends RouteContextKind>(
  builders: ExtensionBuilders<K>,
): ExtendRouteContextResult<K>;

interface ExtendRouteContextResult<K extends RouteContextKind> {
  defineRootContext: {
    // Explicit or uniform vars (see the base `defineRootContext`)
    <TPath extends string, TVars extends object = {}>(
      path: TPath,
      middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
    ): ReaugmentContext<K, TPath, TVars>;
    // Fold of the `Variables` of each middleware (see the base `defineRootContext`).
    // `_TVars` is internal. Do not pass it.
    <
      TPath extends string,
      TMws extends readonly MiddlewareHandler[],
      _NoExplicitTypeArgs,
      _TVars extends object = FoldVars<TMws>,
    >(
      path: TPath,
      middlewares?: readonly [...TMws] & CheckRootArray<TMws>,
    ): ReaugmentContext<K, TPath, _TVars>;
  };
  defineChildContext: {
    // Value form
    <TPath extends string, TParentPath extends string, TParentVars extends object>(
      parent: { path: TParentPath; vars: TParentVars },
      path: TPath,
    ): ReaugmentContext<K, `${TParentPath}${TPath}`, TParentVars>;
    // Curried form
    <TParentContext extends { path: string; vars: object }>(): <TPath extends string>(
      path: TPath,
    ) => ReaugmentContext<K, `${TParentContext['path']}${TPath}`, TParentContext['vars']>;
  };
  /** @deprecated Use defineRootContext. Removed in 2.0. */
  defineRootRoute: ExtendRouteContextResult<K>['defineRootContext'];
  /** @deprecated Use defineChildContext. Removed in 2.0. */
  defineChildRoute: ExtendRouteContextResult<K>['defineChildContext'];
}
```

Returns `defineRootContext` and `defineChildContext` whose contexts carry custom builder methods in addition to `.middleware()`. The deprecated keys `defineRootRoute` and `defineChildRoute` hold the same functions, and version 2.0 removes them. Each method threads the path and the accumulated vars of the route. The library applies the augmentation again through `.middleware()` and through the return values of the methods, so the builders survive chaining. An extended context has no bindings: `bindings` is `{}`, its `.middleware()` does not add the `Bindings` of a middleware, and its children do not get the bindings of a parent. Use the base `defineRootContext` and `defineChildContext` for an app with bindings.

Describe the extended context as a self-referential interface that extends `RouteContextBase`. An interface is the recursion boundary that TypeScript needs, because a mapped-type alias trips "excessively deep". Pair it with a one-line `RouteContextKind`. Then pass the kind as the type argument and the runtime builders as the argument.

### Supporting types

<!-- doc-check: skip -->

```ts
// Higher-kinded slot mapping (path, vars) onto your context interface.
interface RouteContextKind {
  readonly path: string;
  readonly vars: object;
  readonly type: unknown;
}

// Evaluates a kind at concrete path/vars — the re-augmented context type.
type ReaugmentContext<K extends RouteContextKind, TPath extends string, TVars extends object> =
  (K & { path: TPath; vars: TVars })['type'];

// Base members (path, vars, middlewares, kind-aware middleware and bind) your interface extends.
interface RouteContextBase<K extends RouteContextKind, TPath extends string, TVars extends object>
  extends Omit<RouteContext<TPath, TVars>, 'middleware' | 'bind'> {
  middleware: {
    // Inline handler (see `RouteContext.middleware`).
    <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
      handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
    ): ReaugmentContext<K, TPath, TVars & TNewVars>;
    // Reusable typed middleware (see `RouteContext.middleware`).
    <THandler extends MiddlewareHandler<any, any, any>, _NoExplicitTypeArgs>(
      handler: THandler & CheckMiddlewareFits<THandler, TVars>,
    ): ReaugmentContext<K, TPath, TVars & HandlerSets<THandler>>;
  };
  // See `RouteContext.bind`. The returned context keeps the builders of `K`.
  bind: <TKey extends string, TValue, _TLoaderVars extends TVars = TVars>(
    key: BindKey<TKey, _TLoaderVars>,
    param: BindParam<TPath>,
    load: BindLoader<_TLoaderVars, TValue> & CheckBindLoader<TValue>,
  ) => ReaugmentContext<K, TPath, TVars & { [Key in TKey]: NonNullable<Awaited<TValue>> }>;
}

// The custom builder names a kind adds on top of RouteContextBase.
type ExtensionNames<K extends RouteContextKind>;

// The runtime builders map: { [name]: (context) => (...args) => RouteContext }. Each builder's
// parameters are typed from your interface's method (at a loose `string` path and
// `object` vars, so a `ParamKeys<TPath>` param is `never`) and it must return a
// context, typically `context.middleware(mw)`. No cast is needed.
type ExtensionBuilders<K extends RouteContextKind>;
```

`middleware` and `bind` are reserved names. `RouteContextBase` declares them, so your interface must not declare a builder with one of these names. `extendRouteContext` wraps both again, so a context keeps its builders after `.middleware()` and after `.bind()`. For the common case (load one value from a path param), use `.bind()` and do not write a builder.

The usage guide section [Adding custom builders with `extendRouteContext`](./usage.md#adding-custom-builders-with-extendroutecontext) has a full example, with `bindRepository`, `ParamKeys`, and the redeclaration guard.

Known display quirk: on an extended context, the vars added by `.middleware<{ s: 1 }>()` display as `object & { s: 1 }` in editor hovers. The `object` comes from the `this['vars'] & object` slot of the `RouteContextKind` pattern. The type is assignable both ways, but an exact-equality check such as `expectTypeOf(context.vars).toEqualTypeOf<{ s: 1 }>()` fails. Use `toMatchTypeOf`.

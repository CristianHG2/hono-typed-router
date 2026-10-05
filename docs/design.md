# Design notes

## Why a separate router builder?

`@hono/zod-openapi` already provides a typed `createRoute` + `openapi()` integration. It does _not_ provide three things.

1. Path types that flow through nested routers. With raw Hono, each sub-app is its own type universe. You cannot statically express "a child context under `/organizations/:id` inherits both the path _and_ the parent's middleware-set variables."
2. A type-safe place to attach context variables. Hono lets you `.use(middleware)`. You must track by hand which middleware adds which variables. You must also refuse by hand to overwrite an existing var.
3. A single place to attach middleware that each route builds from its own config. Examples are scope checks, request logging, and audit hooks. In raw Hono, these end up spread across handlers. They can also hide in `.use('*')` middleware that has to parse the request again to know which route it matched.

This package gives you those three things. It stays out of your way for everything else.

## `RouteContext`: what is it?

`RouteContext<TPath, TVars>` is a small immutable value. It holds three things.

- A path literal (`TPath`). This is the string where the router mounts. The type carries it, so child paths can concatenate it.
- A vars phantom (`TVars`). This is the accumulated map of variables that all middleware on this context set on `c.var`.
- The runtime middleware list that `makeRouter` installs.

The constructor is private. You get a `RouteContext` only from `defineRootContext` or `defineChildContext`. Both preserve `TPath` and `TVars` precisely.

### Two forms of `defineChildContext`

`defineChildContext(parent, segment)` (the value form) infers everything from the parent value. Its runtime `path` is `parent.path` joined with `segment` by `/`. This is the full path when every ancestor is a root or a value-form child. The router built from it must still mount under the parent's router, which adds the parent's part of the path. So the context also carries the relative `segment`, and `makeRouter` uses it as the base path of the router. Without that split, a mounted value-form child is served at `/api/api/things`.

`defineChildContext<typeof parent>()(segment)` (the curried form) takes the parent as a type only. It stays, and it is not deprecated, because the file-per-route layout has circular imports. A parent module imports the routers of its children to mount them. Each child imports the context of its parent. With the curried form, that import can be `import type`, so there is no runtime cycle. The value form reads the parent value at module load, and a cycle does not provide it. The runtime `path` of a curried child is only its segment. Its type is the full path.

Neither form copies the middlewares of the parent into the child. Mounting the router of the child under the router of the parent runs them. A copy runs them twice.

### Middleware on a context

`.middleware<NewVars>(handler)` returns a new context with `NewVars` merged into `TVars`. The signature of the handler is constrained to `MiddlewareHandler<{ Variables: TVars & NewVars }, TPath>`. The handler sees what is already in `c.var` and can set the new vars.

With a type argument, a constraint on the type argument blocks redeclaration (`NewVars extends NoRedeclare<NewVars, TVars>`). Each key that is already in `TVars` must be the string `"Cannot redeclare existing var: <key>"`. So `.middleware<{ existing: X }>()` fails once on the type argument, and the handler keeps its contextual types.

Without a type argument, a pre-typed handler takes a second signature. It splits the `Variables` of the handler into the vars that it reads and the vars that it sets. `ContextEnv<typeof ctx, NewVars>` records the read vars in a type-only `READS` key. A handler without that key reads nothing and sets all its `Variables`. The handler fits when the context has every read var and none of the set vars. So a set-only `createMiddleware<{ Variables: X }>` fits any context. A `ContextEnv` handler fits its context and every descendant with more vars.

Hono's `Context` is invariant in `Variables`. An exact-match rule ties each reusable middleware to one context. The reads and sets split removes that coupling. One gap stays. A handler whose `Variables` equal the context vars still matches the inline signature with `NewVars = {}`. So a second application of the same middleware compiles.

## The `createRouter` router maker and `routeMiddleware`

The hook lives at the router maker level, not at the level of each `makeRouter` call. Every router in an app generally wants the same route middleware factories. A hook on each call re-creates the coupling that this design removes.

The hook shape is `(route: RouteConfig, meta: RouteMeta) => MiddlewareHandler | undefined`. It is curried for two reasons.

- Per-route work happens once. A scope-check route middleware factory can read `route.security` once at declaration and precompute the required scopes. It does not read it on every request.
- The returned value is a vanilla Hono middleware. There is no new contract to learn. `next()`, returning a `Response`, and throwing all behave as they do anywhere else in Hono.

A route middleware factory returns `undefined` when a route needs no middleware. Then the route does not run a no-op, and `showRoutes` does not list one.

`defineRoute` builds the middlewares of each route and records them with the returned config. `app.openapi` registers them when it registers the route, with `app.on(METHOD, path, ...mws)`. It converts the OpenAPI `{param}` path to the Hono `:param` form in the same way as `@hono/zod-openapi`. The design uses `on`, not `use(path)` plus a method check. So the middlewares match exactly the requests that the handler of the route matches. This includes HEAD requests, which Hono serves through the GET handlers.

### Attach at registration

The router attaches middlewares at registration, not at declaration. So the run order equals the registration order. An `app.use()` that the callback adds before `app.openapi` runs first. A route that is declared but not registered attaches nothing.

This choice has a cost, which is a check. A router with options must see its own configs in `openapi`. Otherwise the options silently do not apply. So `openapi` throws a `TypeError` for three kinds of config: a `createRoute` config, a copy of a declared config, or a config from another router. A router without options keeps accepting `createRoute` configs. So does a router with options that change no route.

Some registrations bypass the wrapper. These are routes on another `OpenAPIHono`, for example one that the callback creates, or `app.basePath(...)`. The route middlewares of these routes are not attached. The router cannot see these registrations, so it checks the result of the callback instead. If the callback returns a different app, and a declared route has route middlewares that were not attached, the router throws a `TypeError`. Each router keeps a list of its declared routes for this check. The `openapi` wrapper uses the same records. On a router maker without options, the wrapper also records each `createRoute` config that it registers. It records a config without route middlewares from the `defineRoute` of another router in the same way. The record goes to the router that registers the config, not to the router that declared it. The duplicate check reads these records. A config can go to more than one router, so the wrapper does not key these records by config. Each router records a config once, also when it registers the config two times.

## `routeDefaults`: a shared RouteConfig fragment

`routeDefaults` exists for the same reason as `routeMiddleware`. In 0.x it was named `base`, and that name is a deprecated alias. Every route shares some concerns. Examples are a standard set of error response shapes, a global `security` requirement, and a `tags` prefix. Today there is no good place for them other than copy-paste or a userland wrapper around `createRoute`.

The deep-merge rules make `routeDefaults` _additive_ in the cases that matter.

- Plain objects recurse. Adding `responses: { 401: ... }` in `routeDefaults` does not remove the `responses: { 200: ... }` of the route.
- Arrays concat and dedupe. So `tags` and `security` accumulate across the defaults and the route. The OpenAPI meaning of `security` is "any of". The dedupe only keeps the list clean.
- `security: []` on a route replaces the default `security`. In OpenAPI, an empty `security` on an operation removes the inherited requirement. So a route that writes `[]` means "public". The rule applies to `security` only. A generic "empty array replaces" rule makes `tags: []` silently drop the default tags.
- Zod schemas at the same slot are unioned with `.or()`. This rule is the key rule for the validation-error case. Both `routeDefaults` (a 422 for the project) and a route (a 422 for the route) commonly define a schema. The right meaning is "the response can have either shape." The wrong meaning is "the route silently drops the default contract." The type-level result is `ZodUnion<readonly [Base, Route]>`, so the handler must satisfy the discriminated union.
- For everything else, the route wins. The route is authoritative for its `description`, its `summary`, and its scalar overrides.

### Types of the merge

The type system reflects the merged shape through `DeepMerge<TBase, TRouteConfig>`. So `app.openapi(declared, handler)` rejects handlers that do not satisfy the _combined_ contract. The type follows the runtime rules exactly where they are observable. Merged arrays are typed `(Base[number] | Route[number])[]`, not a concatenated tuple, because the dedupe makes the length unknowable. A route key that can be `undefined` widens to `Base | Merged | undefined`, because an explicit `undefined` is copied over the base value. One gap is known: optional (`?`) modifiers are not preserved through the merge.

The check for "is this a zod schema" relies on a `_def` brand at both the type level and the runtime level. This couples the library to the internal shape of zod. The coupling is honest, because zod is already a hard peer dep through `@hono/zod-openapi`.

## `transformRoute`: runtime escape hatch

`transformRoute` is intentionally _runtime-only_. It has no type effect. Two use cases are real: "always derive `operationId` from the method and `meta.path`", and "tag every route with the deploy stage". A type-level encoding needs one of two things. One is a brittle template-literal type. The other is to ask the user to declare the effect of the transform twice, once at the value and once at the type. Neither is worth it for ergonomics.

The hook runs _after_ the `routeDefaults` merge and _before_ the route middleware factories. This order has three effects.

- The transformer sees the fully resolved config, with `routeDefaults` applied. So it can derive metadata from the final shape.
- The route middleware factories often precompute scope sets or audit metadata from the route. They see the transformed config. So derived fields like `operationId` are observable to them.
- The caller of `defineRoute()` receives the transformed config. So the value handed to `app.openapi(declared, handler)` reflects the runtime truth.

### `meta.path`

Both hooks get a second argument, `meta: RouteMeta`. `meta.path` is the full mount path of the router joined with the relative path of the route. The own `path` of the config stays relative, usually `'/'`. The route registers on a router whose base path already holds the segment of the context. A full path on the config registers the route at a doubled path. The code computes `meta.path` once, before `transformRoute`. So a hook that rewrites `config.path` does not change what the route middleware factories see in `meta`.

The context alone cannot give the mount path. The runtime path of a curried child is only its segment, because its parent is a type-only import. So the routers pass the mount path down. A parent calls each child router with an internal `{ caller, basePath, lineage }` argument. `caller` names the public function that the error messages quote, `makeRouter` or `mountRouter`. `basePath` holds the full path of the parent. The child joins it with its segment, with the same `joinChildPath` as `defineChildContext`. The mount guard (below) uses `lineage`.

The mount path is where Hono serves the child, whatever form defined its context. So one rule covers curried children, value-form children, and a value-form child of a curried parent. The argument is not in the public router type, which stays `() => ...`. A router is still called as `childRouter()`. `ChildRouter` and the schema inference of the children do not change. When a router is mounted, `meta.path` is always the full path.

A router called with no argument has no parent to ask. It falls back to the runtime `path` of its context. This occurs when you call the router directly or wrap it in another function. For a root, that is the full path. For a value-form child, it is the full path only when every ancestor is a root or a value-form child. A value-form child with a curried ancestor gets a partial path that starts at the segment of that ancestor. A curried child gets only its segment. The base path of the router is still the segment. Only `meta.path` uses the mount path.

### Mount guard

A child context does not copy the middlewares of its parent. The router of the parent runs them, because the router of the child mounts under it. Take a value-form child that is defined under an auth-protected parent but mounted under a different parent. It type-checks, because the vars are only a type. It then serves its routes without the auth middleware. The router checks this at runtime and throws a `TypeError`. The message starts with `hono-typed-router: makeRouter:`. For the children of `mountRouter`, it starts with `hono-typed-router: mountRouter:`. The message names both paths.

#### Identity of a context

Every context that `createRouteContext` builds gets an internal identity. The identity is a unique `id` (a `Symbol`) and a `lineage`. A value-form child also records the `parentId` and `parentPath` of the exact context passed as `parent`. The `lineage` is the list of ids of the context and of the contexts that it derives from with `.middleware()`. It ends with its own `id`. Roots and value-form children start a new lineage.

A `.middleware()` call returns a new context. The new context gets a new `id`, appends it to the lineage of its source, and keeps its `parentId`. The identity is stored under a module-private symbol key, not in the public `RouteContext` type. An object spread copies it. The spread is, for example, the `augment` of `extendRouteContext`. `Object.keys` and `JSON.stringify` do not show it. A WeakMap or a non-enumerable property does not survive that spread.

#### The check

A parent router passes `{ caller, basePath, lineage }` to each child router that it mounts. A child router with a `parentId` throws a `TypeError` when the `lineage` of the mount does not contain that `parentId`. So a child of `root` mounts under `root.middleware(a)`. It also mounts under `root.middleware(a).middleware(b)`. Those contexts run every middleware that the type of the child assumes, plus more.

A child of `root.middleware(a)` throws under `root`, which is an ancestor. It also throws under `root.middleware(c)`, which is a sibling branch. Both lack `a`, which is the auth-bypass case.

A value-form child starts a new lineage. It does not extend the lineage of its parent. Otherwise a child of `root` passes the check under a sibling child of `root`, and it serves its routes under the path of that sibling. Builders of `extendRouteContext` keep the lineage. They return `.middleware()` results, and `augment` copies the identity.

`mountRouter` calls each child router with the same argument, so the same check runs for its children.

#### What the guard does not check

The guard does not check four cases.

- Curried children. Their parent is a type-only import, so there is no parent value to record.
- A router called directly. It has no parent.
- A router wrapped as `() => childRouter()` in `children`. The wrapper drops the mount argument.
- A parent object that `defineRootContext` or `defineChildContext` did not build.

## Error handling: `handle` and `onError`/`handleErrors`

`handle(c, fn, arms)` adds a _type-level bridge_ between the arms that you wire and the responses that the route declares. `handleErrors` widens its return type with the response of each arm (`ArmsResponse<TArms>`, that is `Exclude<Awaited<TResult>, symbol>` per arm). `app.openapi(declared, handler)` type-checks that widened value against the `responses` of the route. So an arm that emits a `409` that the route never declared is a compile error. A body with the wrong shape is also a compile error. It is not a runtime surprise. The OpenAPI contract and the runtime error mapping must agree.

### `Exclude<Awaited<TResult>, symbol>`

The type is not `Exclude<TResult, Rethrow>`. An arm that can `rethrow()` infers a `TResult` that includes a `Promise<Rethrow>` branch. Without the `Awaited`, the sentinel survives `Exclude` and leaks into the response union. An `async () => rethrow()` arm widens the sentinel to a bare `symbol`. So the type excludes the whole primitive, not the `Rethrow` literal.

### The input proxy

The input proxy is lazy and cached. `fn` sees `{ param, query, json, ... }`. The proxy pulls each target from `c.req.valid` only when `fn` destructures it, and only once. Untouched targets cost nothing.

### Positional arms

Arms are positional, and the result is a plain promise. The 0.x API was `handler(c, fn).errors([...])`, a thenable with a method. It needed memoization so that awaiting it and calling `.errors()` did not run the body twice. Its stack frames read `HandlerInvocation.then`. `handle(c, fn, arms?)` has none of that. With no arms, its type is exactly `Promise<R>`. The thenable stays as the deprecated `handler`, which is implemented on top of `handle`.

### Arms are values

Arms are values that routes reuse. `onError(Ctor, handler)` returns a plain `ErrorArm`. The domain-specific arms (`recordNotFoundArm`, `uniqueViolationArm`, and so on) are userland one-liners over `onError`. The library ships only the generic dispatch.

### `matchErrors`

`matchErrors` takes the error union as a class list. TypeScript does not track what a function throws. There is no `throws` clause, and a `catch` binding is `unknown`. So the body cannot give the union of errors that a route maps. The caller states it once, as the class list. The library derives the rest. It derives one required handler key per class. It types each handler with its own class. It derives one arm per class, so the result types the same way as the `onError` arms.

The keys come from a literal `_tag`, or else a literal `name`. This is the convention of better-result (`TaggedError`, `error.match({...})`) and of Effect (`Data.TaggedError`, `catchTags`). Classes written for those libraries work unchanged, and the keys read as the error names.

Dispatch gates on `instanceof`, like `onError`. The arm handles an error that is an instance of any listed class, including an unlisted subclass. The runtime tag of the error (`_tag`, else `name`) then picks the handler. So the order in the list does not matter. The tag of a class is an instance field. Code cannot read it from the constructor without constructing the class. So the key must come from the thrown error.

This has a cost. Take a subclass of a `name`-tagged class that adds a `_tag` equal to the tag of another listed class. Its errors go to the handler of that other class, with the wrong parameter type. Do not reuse tags across unrelated classes.

## `extendRouteContext`: type-safe context augmentation

Binding a repository to a `:param` is common. Each time, you hand-roll the recursive wrapper that augments the context and augments it again after `.middleware()`. That is a papercut. `extendRouteContext` owns that recursion, so a consumer only declares the method signatures.

One design constraint shaped the API: the extended context must be an `interface`, not a mapped-type alias. A fully auto-derived approach maps the extension set to methods and has each method return re-derive the context. It trips the TypeScript error "excessively deep, possibly infinite". A type alias expands eagerly during instantiation, while an interface stays a lazy reference. The base `RouteContext.middleware` chains without this problem for the same reason.

So the consumer supplies a self-referential interface that extends `RouteContextBase`. The consumer also supplies a one-line `RouteContextKind`. It is a higher-kinded slot that lets `extendRouteContext` apply an unapplied two-parameter interface. In exchange, chaining is unbounded. Every method threads the path and the vars. Every method has a redeclaration guard (in the key position) and the `ParamKeys` constraint.

### `.bind()`

`.bind(key, param, load)` is built in. "Load a value from a path param, else 404" is the most common context builder. Before, each app wrote the same `bindOrganization`-style wrapper around `.middleware()`. Or it wrote an `extendRouteContext` kind for one builder. `.bind()` returns `c.notFound()` for a missing value, so the app keeps control of the 404 body. `extendRouteContext` stays the mechanism for all other builders. It wraps `.bind()` again, so an extended context keeps its builders.

## What this package deliberately omits

- Domain coupling. The package has no repository _implementation_, no scope enum, and no auth glue. `extendRouteContext` provides the _mechanism_ to add a `bindRepository`-style builder. `onError` and `handleErrors` provide the mechanism to map domain errors to responses. The actual repositories, error classes, and scope unions stay in userland (see the [usage guide](./usage.md)).
- A generic "validate this before/after the handler" lifecycle. That is the job of `routeMiddleware`. If Hono middleware can express a use case, use Hono middleware.
- Catch-all error mapping. Hono's `app.onError` already handles that.

## Open questions / future work

Children typing is the open topic. The schema part is done. `children` is a `const` type parameter. The `Schema` of the app is the schema of the parent intersected with the schema of each child. So `hc` and `testClient` see the routes of the children. It is an intersection, not a union. A union fails with TS2589 (excessively deep) in `testClient(app)` with 500 children, while the intersection still type-checks.

The code checks a value-form child against its parent at runtime (see "Mount guard" above). It does not check a curried child. With `children`, the callback of `makeRouter` must return the app or nothing. Without `children`, a callback that returns an app with no typed routes is a compile error.

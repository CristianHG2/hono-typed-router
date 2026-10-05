import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RouterCaller } from './mount-guard';
import { joinPath, toHonoPath } from './path-params';

/** What `defineRoute` records for each route config that it returns. */
type DeclaredRoute = {
  /** The route config that `defineRoute` returned. */
  readonly route: RouteConfig;
  /** The app whose `defineRoute` declared the route. Only this app may register it. */
  readonly owner: OpenAPIHono;
  /** The middlewares from the `routeMiddleware` factories, without `undefined` results. */
  readonly mws: readonly MiddlewareHandler[];
  /** `true` after `openapi` attached `mws`, so a second registration does not attach them again. */
  attached: boolean;
  /** `true` after `openapi` of `owner` registered the route. */
  registered: boolean;
};

/**
 * The route configs that a `defineRoute` returned, keyed by config object. The weak keys
 * let a config and its middlewares be collected with the app.
 */
const DECLARED = new WeakMap<object, DeclaredRoute>();

/** The same records, for each router, in declaration order. */
const BY_ROUTER = new WeakMap<OpenAPIHono, DeclaredRoute[]>();

/** Records a route config that `defineRoute` returns, with its app and its middlewares. */
export const recordRoute = (
  route: RouteConfig,
  owner: OpenAPIHono,
  mws: readonly MiddlewareHandler[],
) => {
  const entry: DeclaredRoute = { route, owner, mws, attached: false, registered: false };
  const list = BY_ROUTER.get(owner);

  DECLARED.set(route, entry);

  if (list === undefined) {
    BY_ROUTER.set(owner, [entry]);
  } else {
    list.push(entry);
  }
};

/**
 * The route configs that the `defineRoute` of `router` returned and that `router.openapi`
 * registered, in declaration order. A route from `createRoute`, or a route registered on
 * another app, is not in the list.
 */
export const registeredRoutes = (router: OpenAPIHono): RouteConfig[] =>
  (BY_ROUTER.get(router) ?? []).filter((entry) => entry.registered).map((entry) => entry.route);

/**
 * Throws when a route declared on `router` has route middlewares that `openapi` did not
 * attach. The caller runs it when the callback returned an app that is not `router`: a route
 * registered on that app does not run its route middlewares. A returned app is allowed
 * when every declared route attached its middlewares, or when no route has middlewares.
 */
export const assertRoutesAttached = (
  router: OpenAPIHono,
  fullPath: string,
  caller: RouterCaller,
) => {
  const missed = BY_ROUTER.get(router)?.find((entry) => !entry.attached && entry.mws.length > 0);

  if (missed === undefined) return;

  throw new TypeError(
    `hono-typed-router: ${caller}: the ${describeRoute(fullPath, missed.route)} has route middlewares that were not attached, because the callback returned a different app. Return the app that the callback received, or register the routes on it.`,
  );
};

// Not the generic signature of `openapi`: a comparison with it costs about 146,000 type
// instantiations when TypeScript checks this file.
type OpenapiFn = (...args: never[]) => object;

/**
 * Wraps the `openapi` method of an app without `createRouter` options. Such an app accepts
 * every route config, as before. A config from the `defineRoute` of another app that has
 * route middlewares throws, because this app would register the route without them.
 */
export const attachOnOpenapi = (app: OpenAPIHono) => {
  wrapOpenapi(app, (route) => {
    const entry = DECLARED.get(route);

    if (entry !== undefined && (entry.owner === app || entry.mws.length > 0)) {
      attach(app, route, entry);
    }
  });
};

/**
 * As {@link attachOnOpenapi}, but a config that did not come from this app's `defineRoute`
 * also throws: the `createRouter` options of this app do not apply to it. `options` names
 * the options that change a route, and it is not empty.
 */
export const guardOpenapi = (app: OpenAPIHono, fullPath: string, options: readonly string[]) => {
  wrapOpenapi(app, (route) => {
    const entry = DECLARED.get(route);

    if (entry === undefined) {
      const named =
        options.length === 1 ? `${options[0]} option does` : `${options.join(', ')} options do`;

      throw new TypeError(
        `hono-typed-router: openapi: the ${describeRoute(fullPath, route)} was not declared with the defineRoute() of this router, so its ${named} not apply. Declare it with defineRoute(method, config) inside this callback.`,
      );
    }

    attach(app, route, entry);
  });
};

const wrapOpenapi = (app: OpenAPIHono, before: (route: RouteConfig) => void) => {
  // zod-openapi defines `openapi` as an instance arrow function, so a call without `this`
  // works. `openapiRoutes` calls `this.openapi`, so it also goes through the wrapper.
  const original: OpenapiFn = app.openapi;

  // The wrapper has the same parameters and returns the result of the original (the same
  // app). It is a runtime change only: the type of `app.openapi` does not change.
  Object.defineProperty(app, 'openapi', {
    value: (route: RouteConfig, ...rest: never[]) => {
      before(route);

      // SAFETY: the arguments of this call go to the original `openapi` unchanged.
      return original(...([route, ...rest] as never[]));
    },
    writable: true,
    configurable: true,
    enumerable: true,
  });
};

const attach = (app: OpenAPIHono, route: RouteConfig, entry: DeclaredRoute) => {
  if (entry.owner !== app) {
    throw new TypeError(
      `hono-typed-router: openapi: the ${route.method.toUpperCase()} route was declared by the defineRoute() of another router. Its route middlewares were built for that router. Declare it with defineRoute(method, config) inside this callback.`,
    );
  }

  entry.registered = true;

  if (entry.attached || entry.mws.length === 0) return;

  entry.attached = true;
  // `on(METHOD, path)` instead of `use(path)` and a method check: Hono serves HEAD through
  // the GET handlers, so the middleware also runs for HEAD. The path is converted from
  // OpenAPI `{param}` to Hono `:param` as zod-openapi does when it registers the route, so
  // both match the same requests.
  app.on(
    route.method.toUpperCase(),
    toHonoPath(route.path),
    // SAFETY: `mws` is not empty. The tuple cast picks the `(method, path, ...handlers)`
    // overload of `on`; a plain `MiddlewareHandler[]` spread picks the `(method, path[])` one.
    ...(entry.mws as [MiddlewareHandler, ...MiddlewareHandler[]]),
  );
};

const describeRoute = (fullPath: string, route: Partial<RouteConfig>): string =>
  `${String(route.method ?? '').toUpperCase()} route at '${toHonoPath(joinPath(fullPath, route.path ?? '/'))}'`;

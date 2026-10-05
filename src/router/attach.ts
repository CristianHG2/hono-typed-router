import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RouterCaller } from './mount-guard';
import { toHonoPath } from './path-params';
import { honoJoin } from './route-match';

type DeclaredRoute = {
  readonly route: RouteConfig;
  /** Only this app can register the route. */
  readonly owner: OpenAPIHono;
  readonly mws: readonly MiddlewareHandler[];
  attached: boolean;
  registered: boolean;
  /** `false` for a config that did not come from the `defineRoute` of `owner`. */
  readonly declared: boolean;
};

// Weak keys let the garbage collector free a config and its middlewares with the app.
const DECLARED = new WeakMap<object, DeclaredRoute>();

// In declaration order.
const BY_ROUTER = new WeakMap<OpenAPIHono, DeclaredRoute[]>();

export const recordRoute = (
  route: RouteConfig,
  owner: OpenAPIHono,
  mws: readonly MiddlewareHandler[],
) => {
  const entry: DeclaredRoute = {
    route,
    owner,
    mws,
    attached: false,
    registered: false,
    declared: true,
  };

  DECLARED.set(route, entry);
  addEntry(entry);
};

const addEntry = (entry: DeclaredRoute) => {
  const list = BY_ROUTER.get(entry.owner);

  if (list === undefined) {
    BY_ROUTER.set(entry.owner, [entry]);
  } else {
    list.push(entry);
  }
};

const isRecorded = (app: OpenAPIHono, route: RouteConfig): boolean =>
  BY_ROUTER.get(app)?.some((entry) => entry.route === route) ?? false;

/** A route config that `router.openapi` registered. */
export type RegisteredRoute = {
  readonly route: RouteConfig;
  /** `true` when the `defineRoute` of the router returned the config. */
  readonly declared: boolean;
};

/**
 * The route configs that `router.openapi` registered, each one time, in registration order.
 * Limit: a route on `app.basePath(...)` or a raw `app.get()` is not in the list.
 */
export const registeredRoutes = (router: OpenAPIHono): RegisteredRoute[] =>
  (BY_ROUTER.get(router) ?? [])
    .filter((entry) => entry.registered)
    .map(({ route, declared }) => ({ route, declared }));

/**
 * Throws when a route of `router` has route middlewares that `openapi` did not attach. This
 * occurs when the callback registers the route on another app and returns that app.
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
// instantiations in this file.
type OpenapiFn = (...args: never[]) => object;

/**
 * Wraps `openapi` on an app without `createRouter` options. The app accepts each route
 * config. It throws for a config with route middlewares from another app, because it cannot
 * run them. It records the other configs, so the duplicate check sees them.
 */
export const attachOnOpenapi = (app: OpenAPIHono) => {
  wrapOpenapi(app, (route) => {
    const entry = DECLARED.get(route);

    if (entry === undefined || (entry.owner !== app && entry.mws.length === 0)) {
      if (isRecorded(app, route)) return;

      addEntry({
        route,
        owner: app,
        mws: [],
        attached: true,
        registered: true,
        declared: false,
      });
    } else {
      attach(app, route, entry);
    }
  });
};

/**
 * As {@link attachOnOpenapi}, but a config that did not come from the `defineRoute` of this
 * app throws, because `options` do not apply to it.
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
  // zod-openapi defines `openapi` as an arrow function, so a call without `this` works.
  // `openapiRoutes` calls `this.openapi`, so it also goes through the wrapper.
  const original: OpenapiFn = app.openapi;

  Object.defineProperty(app, 'openapi', {
    value: (route: RouteConfig, ...rest: never[]) => {
      before(route);

      // SAFETY: the arguments go to the original `openapi` without change.
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
  // `on(METHOD, path)` and not `use(path)`: Hono serves HEAD through the GET handlers, so
  // the middleware also runs for HEAD.
  app.on(
    route.method.toUpperCase(),
    toHonoPath(route.path),
    // SAFETY: `mws` is not empty. The tuple cast selects the `(method, path, ...handlers)`
    // overload of `on`. A plain array spread selects the `(method, path[])` overload.
    ...(entry.mws as [MiddlewareHandler, ...MiddlewareHandler[]]),
  );
};

const describeRoute = (fullPath: string, route: Partial<RouteConfig>): string =>
  `${String(route.method ?? '').toUpperCase()} route at '${toHonoPath(honoJoin(fullPath, route.path ?? '/'))}'`;

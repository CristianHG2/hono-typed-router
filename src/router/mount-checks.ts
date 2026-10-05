import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import { inspectRoutes } from 'hono/dev';
import { registeredRoutes } from './attach';
import type { RouterCaller } from './mount-guard';
import { toHonoPath } from './path-params';
import {
  honoJoin,
  normalizeKey,
  pathMatches,
  pathParts,
  routeKey,
  sameMethod,
  type RouteEntry,
} from './route-match';

/** What a built router tells the parent that mounts it. */
type BuiltRouter = {
  /** The context segment where the parent mounts the router. */
  readonly segment: string;
  /** `true` when the context or a descendant has middlewares, such as a `.bind()` loader. */
  readonly ownMiddlewares: boolean;
  /** `METHOD /full/path` of each route of the router and of its children. */
  readonly routes: readonly string[];
};

/** The record of each built app, keyed by the app that the thunk returns. */
const BUILT = new WeakMap<OpenAPIHono, BuiltRouter>();

/** Where a route key came from, for the error message. */
type Source = 'route' | 'child';

/** A route key and where it came from. */
type Declared = { readonly key: string; readonly source: Source };

/** A child as the order check reads it: its record and the routes that its app serves. */
type MountedChild = BuiltRouter & { readonly entries: readonly RouteEntry[] };

type RouterChecks = {
  readonly caller: RouterCaller;
  /** The router that the callback received. Its `defineRoute` records the routes. */
  readonly router: OpenAPIHono;
  /** The app that the thunk returns. The parent reads the record of this app. */
  readonly app: OpenAPIHono;
  readonly fullPath: string;
  readonly segment: string;
  readonly ownMiddlewares: boolean;
  /** The apps of the children, in mount order. */
  readonly children: readonly OpenAPIHono[];
};

/**
 * Checks a router after it mounts its children, and records it for its parent. It throws a
 * `TypeError` when two routes have the same method and full path (param names do not count),
 * or when a child with a param segment comes before a sibling whose routes it gets (see
 * {@link assertChildOrder}).
 *
 * Only the routes that the `defineRoute` of a router declares and that its `app.openapi`
 * registers count as duplicates. A `createRoute` config, or a route registered on another
 * app, is not checked.
 */
export const checkRouter = (checks: RouterChecks) => {
  const { caller, fullPath } = checks;
  const seen = new Map<string, Declared>();
  const routes: string[] = [];

  const add = (key: string, source: Source) => {
    const normalized = normalizeKey(key);
    const previous = seen.get(normalized);

    if (previous !== undefined) throw duplicate(caller, previous, { key, source });

    seen.set(normalized, { key, source });
    routes.push(key);
  };

  for (const route of registeredRoutes(checks.router)) add(declaredKey(fullPath, route), 'route');

  const built = checks.children.flatMap((child): MountedChild[] => {
    const record = BUILT.get(child);

    return record === undefined ? [] : [{ ...record, entries: servedRoutes(child, fullPath) }];
  });

  assertChildOrder(caller, built);

  for (const child of built) {
    for (const key of child.routes) add(key, 'child');
  }

  BUILT.set(checks.app, {
    segment: checks.segment,
    ownMiddlewares: checks.ownMiddlewares || built.some((child) => child.ownMiddlewares),
    routes,
  });
};

/** The key of a declared route, with the path that zod-openapi registers in Hono. */
const declaredKey = (fullPath: string, route: RouteConfig): string =>
  routeKey(route.method, honoJoin(fullPath, toHonoPath(route.path)));

/** Every route and middleware that a child app serves, with full paths. */
const servedRoutes = (child: OpenAPIHono, fullPath: string): RouteEntry[] =>
  inspectRoutes(child).map(({ method, path, isMiddleware }) => ({
    method,
    path: honoJoin(fullPath, path),
    isMiddleware,
  }));

const named = (key: string) => {
  const space = key.indexOf(' ');

  return `${key.slice(0, space)} '${key.slice(space + 1)}'`;
};

const duplicate = (caller: RouterCaller, previous: Declared, next: Declared) => {
  const same = previous.key === next.key;

  const route = same
    ? named(next.key)
    : `${named(previous.key)} and ${named(next.key)} (the same path with a different param name)`;

  const what =
    previous.source === 'child'
      ? `two children declare ${route}`
      : next.source === 'child'
        ? `the callback and a child both declare ${route}`
        : `the callback declares ${route}${same ? ' twice' : ''}`;

  // Different param names give two client keys, but Hono serves both paths with the first route.
  const why = same
    ? 'The client type of that path becomes never'
    : 'Hono gives every request to the first route';

  return new TypeError(
    `hono-typed-router: ${caller}: ${what}. ${why}. Declare each method and path once.`,
  );
};

/**
 * Throws when a child with a param segment, such as `'/:id'`, is mounted before a sibling
 * with a literal segment, such as `'/stats'`, and gets a request of that sibling. Hono matches
 * in registration order, so the request runs the code of the param child.
 *
 * A route or middleware of the param child gets a request of a sibling route when its path
 * matches the path of the sibling route and the methods are the same (`HEAD` counts as `GET`,
 * `ALL` counts as every method). When the param child or a descendant has middlewares that
 * run for every method (`.bind()`, `.middleware()`, `app.use()`), or a route that its
 * `defineRoute` did not declare (such as a raw `app.get()`), every sibling route under the
 * segment counts.
 */
const assertChildOrder = (caller: RouterCaller, built: readonly MountedChild[]) => {
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const [earlier, later] = [built[i]!, built[j]!];

      if (!shadows(earlier.segment, later.segment)) continue;

      const target = collision(earlier, later);

      if (target === undefined) continue;

      throw new TypeError(
        `hono-typed-router: ${caller}: the child '${earlier.segment}' is mounted before '${later.segment}'. Hono matches in registration order, so '${earlier.segment}' gets the requests to ${target.method} '${target.path}'. Put children with literal segments first.`,
      );
    }
  }
};

/** The first route of `later` that a request of which `earlier` gets, if any. */
const collision = (earlier: MountedChild, later: MountedChild): RouteEntry | undefined => {
  const targets = later.entries.filter((entry) => !entry.isMiddleware);

  if (opaque(earlier)) return targets[0];

  return targets.find((target) =>
    earlier.entries.some(
      (entry) => sameMethod(entry.method, target.method) && pathMatches(entry.path, target.path),
    ),
  );
};

/**
 * `true` when the param child runs code that the route-level check does not follow: its
 * context or a descendant has middlewares, an `ALL` middleware is in its app, or its app
 * serves a route that no `defineRoute` of the subtree declared.
 */
const opaque = (child: MountedChild): boolean => {
  if (child.ownMiddlewares) return true;

  const declared = new Set(child.routes);

  return child.entries.some((entry) =>
    entry.isMiddleware ? entry.method === 'ALL' : !declared.has(routeKey(entry.method, entry.path)),
  );
};

// `:name`, `:name?` and `:name{regex}`: the regex, or `undefined` for any value.
const PARAM = /^:[^{?]+(?:{(.*)})?\??$/;

/**
 * `true` when the segment `earlier` matches a request for the segment `later` in at least
 * one part where `later` is a literal: each part of `earlier` is a param that matches the
 * part of `later`, or the same literal. Only the parts that both segments have count.
 */
const shadows = (earlier: string, later: string): boolean => {
  const [e, l] = [pathParts(earlier), pathParts(later)];
  let byParam = false;

  for (let i = 0; i < Math.min(e.length, l.length); i++) {
    const [ep, lp] = [e[i]!, l[i]!];
    const param = PARAM.exec(ep);
    const literal = !lp.startsWith(':') && !lp.startsWith('*');

    if (param === null) {
      if (ep !== lp) return false;
    } else if (literal) {
      const regex = param[1];

      if (regex !== undefined && !new RegExp(`^(?:${regex})$`).test(lp)) return false;

      byParam = true;
    }
  }

  return byParam;
};

import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import { inspectRoutes } from 'hono/dev';
import { registeredRoutes } from './attach';
import type { RouterCaller } from './mount-guard';
import { routeJoin, toHonoPath } from './path-params';
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
  readonly segment: string;
  /** `true` when the context or a descendant has middlewares, such as a `.bind()` loader. */
  readonly ownMiddlewares: boolean;
  /** `METHOD /full/path` of each route of the router and of its children. */
  readonly routes: readonly string[];
  /** The keys in `routes` that a `defineRoute` of the subtree declared. */
  readonly declared: readonly string[];
};

const BUILT = new WeakMap<OpenAPIHono, BuiltRouter>();

type Source = 'route' | 'child';

type Declared = { readonly key: string; readonly source: Source };

type MountedChild = BuiltRouter & { readonly entries: readonly RouteEntry[] };

type RouterChecks = {
  readonly caller: RouterCaller;
  /** The router that the callback received. */
  readonly router: OpenAPIHono;
  /** The app that the thunk returns. The parent reads the record of this app. */
  readonly app: OpenAPIHono;
  readonly fullPath: string;
  readonly segment: string;
  readonly ownMiddlewares: boolean;
  readonly children: readonly OpenAPIHono[];
};

/**
 * Runs after a router mounts its children, and records the router for its parent. Throws a
 * `TypeError` when two routes have the same method and full path (param names do not count),
 * or when a param child gets the requests of a later sibling (see {@link assertChildOrder}).
 * Limit: a raw route such as `app.get()` is not part of the duplicate check.
 */
export function checkRouter(checks: RouterChecks) {
  const { caller, fullPath } = checks;
  const seen = new Map<string, Declared>();
  const routes: string[] = [];
  const declared: string[] = [];

  function add(key: string, source: Source) {
    const normalized = normalizeKey(key);
    const previous = seen.get(normalized);

    if (previous !== undefined) {
      throw duplicate(caller, previous, { key, source });
    }

    seen.set(normalized, { key, source });
    routes.push(key);
  }

  for (const { route, declared: own } of registeredRoutes(checks.router)) {
    const key = declaredKey(fullPath, checks.segment, route);

    add(key, 'route');

    if (own) {
      declared.push(key);
    }
  }

  const built = checks.children.flatMap((child): MountedChild[] => {
    const record = BUILT.get(child);

    return record === undefined ? [] : [{ ...record, entries: servedRoutes(child, fullPath) }];
  });

  assertChildOrder(caller, built);

  for (const child of built) {
    for (const key of child.routes) {
      add(key, 'child');
    }

    declared.push(...child.declared);
  }

  BUILT.set(checks.app, {
    segment: checks.segment,
    ownMiddlewares: checks.ownMiddlewares || built.some((child) => child.ownMiddlewares),
    routes,
    declared,
  });
}

function declaredKey(fullPath: string, segment: string, route: RouteConfig): string {
  return routeKey(route.method, routeJoin(fullPath, segment, toHonoPath(route.path)));
}

function servedRoutes(child: OpenAPIHono, fullPath: string): RouteEntry[] {
  return inspectRoutes(child).map(({ method, path, isMiddleware }) => ({
    method,
    path: honoJoin(fullPath, path),
    isMiddleware,
  }));
}

function named(key: string) {
  const space = key.indexOf(' ');

  return `${key.slice(0, space)} '${key.slice(space + 1)}'`;
}

function duplicate(caller: RouterCaller, previous: Declared, next: Declared) {
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

  const why = same
    ? 'The client type of that path can become never'
    : 'Hono gives every request to the first route';

  return new TypeError(
    `hono-typed-router: ${caller}: ${what}. ${why}. Declare each method and path once.`,
  );
}

/**
 * Throws when a param child (`'/:id'`) comes before a literal sibling (`'/stats'`) and gets a
 * request of that sibling. Hono matches in registration order.
 *
 * A route of the param child gets the request when the path and the method match (`HEAD`
 * counts as `GET`, `ALL` as each method). If the param child has middlewares or a route that
 * no `defineRoute` declared, each sibling route under the segment counts.
 */
function assertChildOrder(caller: RouterCaller, built: readonly MountedChild[]) {
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const [earlier, later] = [built[i]!, built[j]!];

      if (!shadows(earlier.segment, later.segment)) {
        continue;
      }

      const target = collision(earlier, later);

      if (target === undefined) {
        continue;
      }

      throw new TypeError(
        `hono-typed-router: ${caller}: the child '${earlier.segment}' is mounted before '${later.segment}'. Hono matches in registration order, so '${earlier.segment}' gets the requests to ${target.method} '${target.path}'. Put children with literal segments first.`,
      );
    }
  }
}

/** The first route of `later` whose requests `earlier` gets. */
function collision(earlier: MountedChild, later: MountedChild): RouteEntry | undefined {
  const targets = later.entries.filter((entry) => !entry.isMiddleware);

  if (opaque(earlier)) {
    return targets[0];
  }

  return targets.find((target) =>
    earlier.entries.some(
      (entry) => sameMethod(entry.method, target.method) && pathMatches(entry.path, target.path),
    ),
  );
}

/** `true` when the param child runs code that the check of each route cannot follow. */
function opaque(child: MountedChild): boolean {
  if (child.ownMiddlewares) {
    return true;
  }

  const declared = new Set(child.declared);

  return child.entries.some((entry) =>
    entry.isMiddleware ? entry.method === 'ALL' : !declared.has(routeKey(entry.method, entry.path)),
  );
}

// `:name`, `:name?` and `:name{regex}`: the regex, or `undefined` for any value.
const PARAM = /^:[^{?]+(?:{(.*)})?\??$/;

/**
 * `true` when a param part of `earlier` matches a literal part of `later`, and the other
 * parts match. Only the parts that both segments have count.
 */
function shadows(earlier: string, later: string): boolean {
  const [e, l] = [pathParts(earlier), pathParts(later)];
  let byParam = false;

  for (let i = 0; i < Math.min(e.length, l.length); i++) {
    const [ep, lp] = [e[i]!, l[i]!];
    const param = PARAM.exec(ep);
    const literal = !lp.startsWith(':') && !lp.startsWith('*');

    if (param === null) {
      if (ep !== lp) {
        return false;
      }
    } else if (literal) {
      const regex = param[1];

      if (regex !== undefined && !new RegExp(`^(?:${regex})$`).test(lp)) {
        return false;
      }

      byParam = true;
    }
  }

  return byParam;
}

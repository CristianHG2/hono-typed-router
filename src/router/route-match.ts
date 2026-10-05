/** One route or middleware of an app, as `inspectRoutes` from `hono/dev` lists it. */
export type RouteEntry = {
  /** The upper-case method, or `ALL` for `use()` and `all()`. */
  readonly method: string;
  readonly path: string;
  readonly isMiddleware: boolean;
};

/**
 * Joins two paths as the `mergePath` of Hono. A route path `'/'` keeps the base with its
 * trailing slash. Hono routes `'/things'` and `'/things/'` apart, so the keys keep the
 * difference.
 */
export const honoJoin = (base: string, sub: string): string => {
  const head = base.startsWith('/') ? base : `/${base}`;

  if (sub === '/') return head;

  return `${head.endsWith('/') ? head.slice(0, -1) : head}/${sub.startsWith('/') ? sub.slice(1) : sub}`;
};

export const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

/**
 * Replaces each param name with `_`, because Hono serves `/a/:id` and `/a/:x` with the first
 * route. A regex and the `?` marker stay, because they change the requests that match.
 */
export const normalizeKey = (key: string): string => key.replaceAll(/\/:[^/{?]+/g, '/:_');

/** `'GET'` for `HEAD`: Hono serves `HEAD` requests with the `GET` handlers. */
const methodOf = (method: string): string => (method === 'HEAD' ? 'GET' : method);

export const sameMethod = (a: string, b: string): boolean =>
  a === 'ALL' || b === 'ALL' || methodOf(a) === methodOf(b);

/** The parts of a path. A `/` inside a regex param (`:id{a/b}`) does not split it. */
export const pathParts = (path: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let part = '';

  for (const char of path) {
    if (char === '/' && depth === 0) {
      if (part !== '') parts.push(part);

      part = '';
    } else {
      if (char === '{') depth += 1;

      if (char === '}') depth = Math.max(0, depth - 1);

      part += char;
    }
  }

  if (part !== '') parts.push(part);

  return parts;
};

// `:name`, `:name?` and `:name{regex}`: the regex, or `undefined` for any value.
const PARAM = /^:[^{?]+(?:{(.*)})?\??$/;

const isParam = (part: string): boolean => part.startsWith(':') || part === '*';

/** `true` when the part `pattern` can match a request whose part matches `part`. */
const partMatches = (pattern: string, part: string): boolean => {
  if (pattern === part || pattern === '*') return true;

  const param = PARAM.exec(pattern);
  const regex = param === null ? PARAM.exec(part)?.[1] : param[1];

  if (param === null && !isParam(part)) return false;

  // Two params: a request can match both, as far as this check knows.
  if (param !== null && isParam(part)) return true;

  const literal = param === null ? pattern : part;

  return regex === undefined || new RegExp(`^(?:${regex})$`).test(literal);
};

/** Each optional `:param?` either present (without the `?`) or absent. */
const variants = (parts: readonly string[]): string[][] => {
  let out: string[][] = [[]];

  for (const part of parts) {
    const optional = part.startsWith(':') && part.endsWith('?');
    const next: string[][] = [];

    for (const prefix of out) {
      next.push([...prefix, optional ? part.slice(0, -1) : part]);

      if (optional) next.push(prefix);
    }

    out = next;
  }

  return out;
};

const partsMatch = (pattern: readonly string[], parts: readonly string[]): boolean => {
  if (pattern.length === 0) return parts.length === 0;

  const [head, ...rest] = pattern;

  // A trailing `*` also matches the path without more parts, as Hono's `/x/*` matches `/x`.
  if (head === '*' && rest.length === 0) return true;

  if (parts.length === 0) return false;

  return partMatches(head!, parts[0]!) && partsMatch(rest, parts.slice(1));
};

/** `true` when a request for `path` can also match `pattern`. */
export const pathMatches = (pattern: string, path: string): boolean => {
  const targets = variants(pathParts(path));

  return variants(pathParts(pattern)).some((p) => targets.some((t) => partsMatch(p, t)));
};

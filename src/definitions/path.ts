// The path rules of a context: the full path of a child, and the runtime check that rejects
// the OpenAPI `{param}` syntax.

/**
 * A child's full path: the parent's path joined with the child's own segment by one `/`.
 * A parent path that ends in `/` (the root `'/'`) drops that slash when the segment starts
 * with one, so `'/'` + `'/things'` is `'/things'`, not `'//things'`. A segment without a
 * leading `/` under a parent that does not end in one gets one inserted, so `'/api'` +
 * `'things'` is `'/api/things'`. Mirrors `joinChildPath`.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ChildPath<
  TParentPath extends string,
  TPath extends string,
> = TParentPath extends `${infer THead}/`
  ? TPath extends `/${string}`
    ? `${THead}${TPath}`
    : `${TParentPath}${TPath}`
  : string extends TPath
    ? `${TParentPath}${TPath}`
    : TPath extends `/${string}` | ''
      ? `${TParentPath}${TPath}`
      : `${TParentPath}/${TPath}`;

// A segment that starts with `{`: the OpenAPI `{param}` syntax, up to its `}` or the next `/`.
const OPENAPI_PARAM = /^\{([^/}]*)\}?/;

/**
 * The path with each OpenAPI `{name}` segment written as `:name`, or `undefined` when no
 * segment starts with `{`. A `{` inside a Hono regex param (`:id{a/{x}}`) is not a segment
 * start: the braces are counted, so a `/` inside the regex does not start a segment. A `{`
 * without a name becomes nothing, so `'/a/{'` becomes `'/a/'`.
 */
const honoSyntax = (path: string): string | undefined => {
  let depth = 0;
  let out = '';
  let found = false;
  let index = 0;

  while (index < path.length) {
    const char = path[index];

    const match =
      depth === 0 && (index === 0 || path[index - 1] === '/')
        ? OPENAPI_PARAM.exec(path.slice(index))
        : null;

    if (match === null) {
      if (char === '{') depth += 1;

      if (char === '}') depth = Math.max(0, depth - 1);

      out += char;
      index += 1;
    } else {
      const name = match[1] ?? '';

      out += name === '' ? '' : `:${name}`;
      found = true;
      index += match[0].length;
    }
  }

  return found ? out : undefined;
};

/**
 * Internal. Throws a `TypeError` when a segment of `path` starts with `{`, the OpenAPI
 * `{param}` syntax. Hono would mount such a path literally, so the path would return 404. A
 * Hono regex param such as `:id{[0-9]+}` is accepted. The check runs only at runtime: a type
 * check would also reject a generic path parameter.
 */
export const assertHonoPath = (
  fn: 'defineRootContext' | 'defineChildContext',
  path: string,
): void => {
  const fixed = honoSyntax(path);

  if (fixed !== undefined) {
    throw new TypeError(
      `hono-typed-router: ${fn}: the path '${path}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '${fixed}'.`,
    );
  }
};

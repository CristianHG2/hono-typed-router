/**
 * The parent path joined with the child segment, as Hono joins them. Keep it the same as
 * `joinChildPath`.
 *
 * @internal
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
    : TPath extends '/' | ''
      ? TParentPath extends ''
        ? TPath
        : TParentPath
      : TPath extends `/${string}`
        ? `${TParentPath}${TPath}`
        : `${TParentPath}/${TPath}`;

const OPENAPI_PARAM = /^\{([^/}]*)\}?/;

/**
 * The braces are counted, so that a `/` inside a Hono regex param (`:id{a/{x}}`) does not start
 * a segment.
 */
function honoSyntax(path: string): string | undefined {
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
      if (char === '{') {
        depth += 1;
      }

      if (char === '}') {
        depth = Math.max(0, depth - 1);
      }

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
}

/**
 * Hono mounts an OpenAPI `{param}` literally, and the path returns 404. The check runs only at
 * runtime, because a type check also rejects a generic path parameter.
 */
export function assertHonoPath(fn: 'defineRootContext' | 'defineChildContext', path: string): void {
  const fixed = honoSyntax(path);

  if (fixed !== undefined) {
    throw new TypeError(
      `hono-typed-router: ${fn}: the path '${path}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '${fixed}'.`,
    );
  }
}

import type { Context, MiddlewareHandler } from 'hono';
import type { ParamKeys } from 'hono/types';
import type { RouterEnv } from './env';

/**
 * The params that `.bind()` accepts: the required params of the context path. An optional
 * `:param?` is not accepted, because a request can match the path without it.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type BindParam<TPath extends string> = Exclude<ParamKeys<TPath>, `${string}?`>;

/**
 * `true` when `T` is one type, `false` when `T` is a union. `TAll` keeps the whole union
 * while the check distributes over `T`.
 */
type IsOne<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? true : false) : never;

/**
 * The type of the `key` of `.bind()`: `TKey`, or an error message. `.bind()` sets one var, so
 * the key must be one string literal: a `string` key or a union key is an error. A key that
 * the context already has is an error.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type BindKey<TKey extends string, TVars> = string extends TKey
  ? 'Use a string literal for the key'
  : IsOne<TKey> extends true
    ? TKey extends keyof TVars
      ? `Cannot redeclare existing var: ${TKey}`
      : TKey
    : 'Use one string literal for the key';

/**
 * The loader of `.bind()`. It gets the value of the path param and the request context,
 * with the vars and the bindings of the route context. It returns the value of the new var, `null` or
 * `undefined` when there is no value, or a promise of one of these.
 */
export type BindLoader<TVars extends object, TValue, TBindings extends object = {}> = (
  value: string,
  c: Context<RouterEnv<TVars, TBindings>>,
) => TValue;

/**
 * Internal: the middleware that `.bind()` adds. It reads the path param `param` and calls
 * `load`. When the param is missing, or `load` gives `null` or `undefined`, it returns
 * `c.notFound()`. Otherwise it sets the var `key` and calls `next`. An error from `load`
 * goes to `app.onError`. The function name is `bind:<key>`. `inspectRoutes` shows the name,
 * and `showRoutes` shows it only with `{ verbose: true }`.
 */
export const createBindMiddleware = <TValue>(
  key: string,
  param: string,
  load: BindLoader<object, TValue>,
): MiddlewareHandler => {
  const handler: MiddlewareHandler = async (c, next) => {
    const raw = c.req.param(param);

    if (raw === undefined) {
      return c.notFound();
    }

    const value = await load(raw, c);

    if (value === null || value === undefined) {
      return c.notFound();
    }

    c.set(key, value);
    await next();
  };

  Object.defineProperty(handler, 'name', { value: `bind:${key}` });

  return handler;
};

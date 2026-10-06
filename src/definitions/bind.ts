import type { Context, MiddlewareHandler } from 'hono';
import type { ParamKeys } from 'hono/types';
import type { RedeclareMessage, RouterEnv } from './env';

/**
 * The params that `.bind()` accepts: the required params of the context path. An optional
 * `:param?` is not accepted, because a request can match the path without it.
 *
 * @internal Exported for declaration emit.
 */
export type BindParam<TPath extends string> = Exclude<ParamKeys<TPath>, `${string}?`>;

/** `true` when `T` is one type, `false` when `T` is a union. `TAll` keeps the whole union. */
type IsOne<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? true : false) : never;

/**
 * The type of the `key` of `.bind()`: `TKey`, or an error message. The key must be one new
 * string literal.
 *
 * @internal Exported for declaration emit.
 */
export type BindKey<TKey extends string, TVars> = string extends TKey
  ? 'Use a string literal for the key'
  : IsOne<TKey> extends true
    ? TKey extends keyof TVars
      ? RedeclareMessage<TKey>
      : TKey
    : 'Use one string literal for the key';

/**
 * The loader of `.bind()`. It gets the value of the path param and the request context. It
 * returns the value of the new var, `null` or `undefined` for no value, or a promise of one
 * of these.
 */
export type BindLoader<TVars extends object, TValue, TBindings extends object = {}> = (
  value: string,
  c: Context<RouterEnv<TVars, TBindings>>,
) => TValue;

type BindLoaded<T> = T extends Promise<infer U> ? U : T;

/**
 * `'any'` for `any`, `'empty'` for `never`, else `'value'`. TypeScript replaces a type
 * parameter with a permissive wildcard type when it selects the branch of a deferred
 * conditional type. The `[0] extends [1 & T]` test sends the wildcard to `'any'`. Thus a
 * loader with a generic return type is not rejected.
 */
type BindLoadedKind<T> = [0] extends [1 & T] ? 'any' : [T] extends [never] ? 'empty' : 'value';

/**
 * The check of the loader of `.bind()`: an error message when the loader can return only
 * `null`, `undefined`, `void`, `never`, or a promise of one of these. Otherwise `unknown`.
 *
 * @internal Exported for declaration emit.
 */
export type CheckBindLoader<TValue> =
  BindLoadedKind<Exclude<BindLoaded<TValue>, null | undefined | void>> extends 'empty'
    ? 'The loader returns no value: return the value of the var, or null when there is none'
    : unknown;

/**
 * Internal: the middleware that `.bind()` adds (see `RouteContext.bind`). `inspectRoutes`
 * shows its name, and `showRoutes` shows it only with `{ verbose: true }`.
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

import type { Context, MiddlewareHandler } from 'hono';
import type { ParamKeys } from 'hono/types';
import type { RedeclareMessage, RouterEnv } from './env';

/**
 * An optional `:param?` is excluded, because a request can match the path without it.
 *
 * @internal
 */
export type BindParam<TPath extends string> = Exclude<ParamKeys<TPath>, `${string}?`>;

type IsOne<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? true : false) : never;

/** @internal */
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
 * TypeScript replaces a type parameter with a permissive wildcard type when it selects the
 * branch of a deferred conditional type. The `[0] extends [1 & T]` test sends the wildcard to
 * `'any'`, so a loader with a generic return type is not rejected.
 */
type BindLoadedKind<T> = [0] extends [1 & T] ? 'any' : [T] extends [never] ? 'empty' : 'value';

/** @internal */
export type CheckBindLoader<TValue> =
  BindLoadedKind<Exclude<BindLoaded<TValue>, null | undefined | void>> extends 'empty'
    ? 'The loader returns no value: return the value of the var, or null when there is none'
    : unknown;

export function createBindMiddleware<TValue>(
  key: string,
  param: string,
  load: BindLoader<object, TValue>,
): MiddlewareHandler {
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
}

import type { Context, Input } from 'hono';
import { handleErrors } from '../errors';
import type { AnyArm, ArmsResponse, HandlerInvocation, ValidatedProxy } from './types';

function buildProxy<I extends Input>(c: Context<any, any, I>): ValidatedProxy<I> {
  const cached: Record<string, unknown> = {};

  // SAFETY: each string key gives `c.req.valid(key)`, which is the type that
  // `ValidatedProxy<I>` gives to each target.
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== 'string') {
          return;
        }

        if (!(key in cached)) {
          // SAFETY: at runtime `valid` accepts each target string. Only the typed
          // `ValidatedProxy<I>` shows the result.
          cached[key] = (c.req.valid as (target: string) => unknown)(key);
        }

        return cached[key];
      },
    },
  ) as ValidatedProxy<I>;
}

/**
 * Runs a route handler body with a {@link ValidatedProxy} of the validated inputs of the
 * request. With `arms`, {@link handleErrors} handles a thrown `Error`, and the result type adds
 * the response of each arm. Thus `router.openapi(...)` rejects an arm with an undeclared status.
 */
export function handle<I extends Input, R, const A extends ReadonlyArray<AnyArm> = readonly []>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<R>,
  arms?: A,
): Promise<R | ArmsResponse<A>> {
  function run() {
    return fn(buildProxy(c));
  }

  return arms === undefined ? run() : handleErrors(run, arms, c);
}

/**
 * @deprecated Use {@link handle}: `handle(c, fn, arms)` replaces
 * `handler(c, fn).errors(arms)`. Removed in 2.0.
 */
export function handler<I extends Input, TResponse>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<TResponse>,
): HandlerInvocation<TResponse> {
  let pending: Promise<TResponse> | undefined;

  function settle(): Promise<TResponse> {
    if (pending === undefined) {
      pending = handle(c, fn);
    }

    return pending;
  }

  return {
    then(onFulfilled, onRejected) {
      return settle().then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return settle().catch(onRejected);
    },
    finally(onFinally) {
      return settle().finally(onFinally);
    },
    // Stack frames show `HandlerInvocation.then`, not `Object.then`.
    [Symbol.toStringTag]: 'HandlerInvocation',
    errors: <const TArms extends ReadonlyArray<AnyArm>>(arms: TArms) =>
      handleErrors(settle, arms, c),
  };
}

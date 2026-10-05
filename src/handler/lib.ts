import type { Context, Input } from 'hono';
import { handleErrors } from '../errors';
import type { AnyArm, ArmsResponse, HandlerInvocation, ValidatedProxy } from './types';

const buildProxy = <I extends Input>(c: Context<any, any, I>): ValidatedProxy<I> => {
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
};

/**
 * Runs a route handler body with a {@link ValidatedProxy} of the validated inputs of the
 * request. `c.req.valid` reads each target once, at the first access. With `arms`,
 * {@link handleErrors} handles a thrown `Error`, and the result type adds the response of
 * each arm. `router.openapi(...)` checks this type, so an arm with a response that the route
 * does not declare is a compile error.
 *
 * ```ts
 * router.openapi(route, (c) =>
 *   handle(c, async ({ param: { id } }) => c.json(await findOrFail(id), 200), [
 *     onError(RecordNotFoundError, (_err, ec) => ec.json({ message: 'Not found' }, 404)),
 *   ]),
 * );
 * ```
 */
export const handle = <I extends Input, R, const A extends ReadonlyArray<AnyArm> = readonly []>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<R>,
  arms?: A,
): Promise<R | ArmsResponse<A>> => {
  const run = () => fn(buildProxy(c));

  return arms === undefined ? run() : handleErrors(run, arms, c);
};

/**
 * @deprecated Use {@link handle}: `handle(c, fn, arms)` replaces
 * `handler(c, fn).errors(arms)`. Removed in 2.0.
 *
 * Returns a lazy thenable over `handle(c, fn)` with an optional `.errors([...])` step. The
 * body runs one time at most, also when you await it and call `.errors([...])`.
 */
export const handler = <I extends Input, TResponse>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<TResponse>,
): HandlerInvocation<TResponse> => {
  let pending: Promise<TResponse> | undefined;

  const settle = (): Promise<TResponse> => {
    if (pending === undefined) {
      pending = handle(c, fn);
    }

    return pending;
  };

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
    // Stack frames show `HandlerInvocation.then`, not `Promise.then`.
    [Symbol.toStringTag]: 'HandlerInvocation',
    errors: <const TArms extends ReadonlyArray<AnyArm>>(arms: TArms) =>
      handleErrors(settle, arms, c),
  };
};

import type { Context, Input } from 'hono';
import { handleErrors } from '../errors';
import type { AnyArm, ArmsResponse, HandlerInvocation, ValidatedProxy } from './types';

const buildProxy = <I extends Input>(c: Context<any, any, I>): ValidatedProxy<I> => {
  const cached: Record<string, unknown> = {};

  // SAFETY: every string key read through the proxy resolves to `c.req.valid(key)`, which is
  // what `ValidatedProxy<I>` maps each validation target to.
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== 'string') {
          return;
        }

        if (!(key in cached)) {
          // SAFETY: `valid` is typed over `I`'s target keys; at runtime it accepts any target
          // string and the result is only exposed through the typed `ValidatedProxy<I>`.
          cached[key] = (c.req.valid as (target: string) => unknown)(key);
        }

        return cached[key];
      },
    },
  ) as ValidatedProxy<I>;
};

/**
 * Runs a route handler body with a destructurable {@link ValidatedProxy} over the
 * request's validated inputs, optionally under error arms.
 *
 * Each validation target is pulled from `c.req.valid` lazily and cached, so untouched
 * targets are never read and touched ones are read once. With `arms`, a thrown `Error`
 * is dispatched through {@link handleErrors} and the result type is widened with each
 * arm's response; without `arms` the result is exactly `Promise<R>`. Because the
 * widened value is what `router.openapi(...)` checks, an arm that can emit a response
 * the route did not declare is a compile error.
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
 * Returns a lazy thenable over `handle(c, fn)` with an opt-in `.errors([...])` step.
 * The body runs at most once: awaiting the invocation directly and calling
 * `.errors([...])` (in any order) settle the same underlying promise.
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
    // Not 'Promise': stack frames then read `HandlerInvocation.then`, not `Promise.then`.
    [Symbol.toStringTag]: 'HandlerInvocation',
    errors: <const TArms extends ReadonlyArray<AnyArm>>(arms: TArms) =>
      handleErrors(settle, arms, c),
  };
};

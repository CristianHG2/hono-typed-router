import type { Context, Input } from 'hono';
import { handleErrors } from '../errors';
import type { AnyArm, HandlerInvocation, ValidatedProxy } from './types';

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
 * Wraps a route handler body with a destructurable {@link ValidatedProxy} over the
 * request's validated inputs and an opt-in `.errors([...])` step.
 *
 * The body runs at most once: awaiting the invocation directly (thenable) or via
 * `.errors([...])` both settle the same underlying promise. Each validation target
 * is pulled from `c.req.valid` lazily and cached, so untouched targets are never
 * read and touched ones are read once.
 *
 * ```ts
 * router.openapi(route, (c) =>
 *   handler(c, async ({ param: { id } }) => c.json(await findOrFail(id), 200))
 *     .errors([recordNotFoundArm('Not found')]),
 * );
 * ```
 */
export const handler = <I extends Input, TResponse>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<TResponse>,
): HandlerInvocation<TResponse> => {
  const proxy = buildProxy(c);
  const run = () => fn(proxy);

  let pending: Promise<TResponse> | undefined;

  const settle = (): Promise<TResponse> => {
    if (pending === undefined) {
      pending = run();
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

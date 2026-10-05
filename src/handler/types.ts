import type { Input } from 'hono';
import type { InputToDataByTarget, ValidationTargets } from 'hono/types';
import type { AnyArm, ArmsResponse } from '../errors/lib';

export type { AnyArm, ArmsResponse };

/**
 * Destructurable view over a route's validated inputs. Each key is a Hono
 * validation target (`param`, `query`, `json`, `form`, `header`, `cookie`) typed
 * from the route's `Input`, so `({ param, json }) => ...` is fully typed.
 *
 * The view has only the targets that the route declares, so reading a target that the route
 * does not declare is a compile error. A route at a path with required params always has
 * `param`. A `Context` typed with the general `Input` keeps every target. A `Context` with
 * the default `Input` (`{}`), such as a bare `Context`, gives a view with no keys.
 */
export type ValidatedProxy<I extends Input> = {
  [K in ProxyKeys<I>]: InputToDataByTarget<I['out'], K>;
};

// A plain key set, not an `as` clause: the `as` form costs about 10 times more.
type ProxyKeys<I extends Input> = Input extends I
  ? [keyof I] extends [never]
    ? never
    : keyof ValidationTargets
  : keyof ValidationTargets & keyof NonNullable<I['out']>;

/**
 * @deprecated Use {@link handle}, which returns a plain `Promise`. Removed in 2.0.
 *
 * Awaitable result of the deprecated {@link handler}. Behaves as `Promise<TResponse>` on its own;
 * calling `.errors([...])` runs the body under {@link handleErrors} and widens the
 * result with the arms' responses. Because those responses flow into the value
 * returned to `router.openapi(...)`, a response an arm can emit that the route did
 * not declare in `responses` is a compile error.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerInvocation<TResponse> = Promise<TResponse> &
  Readonly<{
    errors: <const TArms extends ReadonlyArray<AnyArm>>(
      arms: TArms,
    ) => Promise<TResponse | ArmsResponse<TArms>>;
  }>;

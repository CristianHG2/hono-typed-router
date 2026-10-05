import type { Input } from 'hono';
import type { InputToDataByTarget, ValidationTargets } from 'hono/types';
import type { AnyArm, ArmsResponse } from '../errors/lib';

export type { AnyArm, ArmsResponse };

/**
 * The validated inputs of a route. Each key is a Hono validation target (`param`, `query`,
 * `json`, `form`, `header`, `cookie`) with the type from the `Input` of the route. The view
 * has only the targets that the route declares. A route with required path params always has
 * `param`. A `Context` with the general `Input` has every target. A `Context` with the
 * default `Input` (`{}`) gives a view with no keys.
 */
export type ValidatedProxy<I extends Input> = {
  [K in ProxyKeys<I>]: InputToDataByTarget<I['out'], K>;
};

// A plain key set, not an `as` clause. The `as` form costs about 10 times more.
type ProxyKeys<I extends Input> = Input extends I
  ? [keyof I] extends [never]
    ? never
    : keyof ValidationTargets
  : keyof ValidationTargets & keyof NonNullable<I['out']>;

/**
 * @deprecated Use {@link handle}, which returns a plain `Promise`. Removed in 2.0.
 *
 * The result of {@link handler}. `.errors([...])` runs the body under {@link handleErrors}
 * and adds the responses of the arms to the result type.
 *
 * @internal
 */
export type HandlerInvocation<TResponse> = Promise<TResponse> &
  Readonly<{
    errors: <const TArms extends ReadonlyArray<AnyArm>>(
      arms: TArms,
    ) => Promise<TResponse | ArmsResponse<TArms>>;
  }>;

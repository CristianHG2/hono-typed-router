import type { Input } from 'hono';
import type { InputToDataByTarget, ValidationTargets } from 'hono/types';
import type { AnyArm, ArmsResponse } from '../errors/lib';

export type { AnyArm, ArmsResponse };

/**
 * The validated inputs of a route, by Hono validation target (`param`, `query`, `json`, `form`,
 * `header`, `cookie`). It has only the targets that the route declares.
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
 * @internal
 */
export type HandlerInvocation<TResponse> = Promise<TResponse> &
  Readonly<{
    errors: <const TArms extends ReadonlyArray<AnyArm>>(
      arms: TArms,
    ) => Promise<TResponse | ArmsResponse<TArms>>;
  }>;

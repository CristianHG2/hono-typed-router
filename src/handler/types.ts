import type { Context, Input } from 'hono';
import type { InputToDataByTarget, ValidationTargets } from 'hono/types';
import type { ErrorArm, RETHROW } from '../errors';

/**
 * Destructurable view over a route's validated inputs. Each key is a Hono
 * validation target (`param`, `query`, `json`, `form`, `header`, `cookie`) typed
 * from the route's `Input`, so `({ param, json }) => ...` is fully typed.
 */
export type ValidatedProxy<I extends Input> = {
  [K in keyof ValidationTargets]: InputToDataByTarget<I['out'], K>;
};

export type AnyArm = ErrorArm<any, any>;

type ArmResponse<TArm> = TArm extends ErrorArm<any, infer TResult>
  ? Exclude<Awaited<TResult>, typeof RETHROW>
  : never;

/** Union of the response types produced by a tuple of arms (sans `Rethrow`). */
export type ArmsResponse<TArms extends ReadonlyArray<AnyArm>> = ArmResponse<TArms[number]>;

/**
 * Awaitable result of {@link handler}. Behaves as `Promise<TResponse>` on its own;
 * calling `.errors([...])` runs the body under {@link handleErrors} and widens the
 * result with the arms' responses. Because those responses flow into the value
 * returned to `router.openapi(...)`, a response an arm can emit that the route did
 * not declare in `responses` is a compile error.
 */
export type HandlerInvocation<TResponse> = Promise<TResponse> &
  Readonly<{
    errors: <const TArms extends ReadonlyArray<AnyArm>>(
      arms: TArms,
    ) => Promise<TResponse | ArmsResponse<TArms>>;
  }>;

export type HandlerFn = <I extends Input, TResponse>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<TResponse>,
) => HandlerInvocation<TResponse>;

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Sentinel returned by an error arm's handler to decline the error and let the
 * next matching arm (or the surrounding `throw`) take over. Compared by identity.
 */
export const RETHROW: unique symbol = Symbol('RETHROW');
export type Rethrow = typeof RETHROW;

/**
 * A single error-handling branch: match errors that are `instanceof ctor`, then
 * run `handle`. The handler either produces a response (`TResult`) or returns
 * `rethrow()` to defer to the next arm.
 */
export type ErrorArm<TErr extends Error, TResult> = Readonly<{
  ctor: new (...args: any[]) => TErr;
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>;
}>;

/**
 * Declares an error arm. `TResult` is inferred from the handler's return, so the
 * arm carries the exact response type it produces (e.g. a `TypedResponse` from
 * `c.json(body, status)`). That precision is what lets `handler().errors([...])`
 * and `handleErrors(...)` widen their return type with the arms' responses.
 */
export const on = <TErr extends Error, TResult>(
  ctor: new (...args: any[]) => TErr,
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>,
): ErrorArm<TErr, TResult> => ({ ctor, handle });

/** Returns the {@link RETHROW} sentinel from inside an arm handler. */
export const rethrow = (): Rethrow => RETHROW;

/** Convenience arm handler: respond with `{ message }` at the given status. */
export const genericErrorHandler =
  <T extends ContentfulStatusCode>(statusCode: T) =>
  (err: Error, c: Context) =>
    c.json({ message: err.message }, statusCode);

type ArmResults<TArr> = TArr extends ReadonlyArray<infer T>
  ? T extends ErrorArm<infer _TErr, infer TResult>
    ? TResult
    : never
  : never;

/**
 * Runs `body()` and, if it throws an `Error`, dispatches to the first matching
 * arm (by `instanceof`). Arms are tried in order; an arm returning `rethrow()`
 * falls through to the next. If no arm matches (or all rethrow), the error is
 * rethrown. Non-`Error` throws bypass the arms entirely.
 *
 * The return type is `TBody` widened with every arm's response type (minus the
 * `Rethrow` sentinel), so callers see the full set of responses the route can
 * produce.
 */
export const handleErrors = async <
  TBody,
  const TArms extends ReadonlyArray<ErrorArm<any, any>>,
>(
  body: () => Promise<TBody>,
  arms: TArms,
  c: Context,
): Promise<TBody | Exclude<Awaited<ArmResults<TArms>>, Rethrow>> => {
  try {
    return await body();
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }
    for (const arm of arms) {
      if (err instanceof arm.ctor) {
        const result = await arm.handle(err, c);
        if (result === RETHROW) {
          continue;
        }
        return result;
      }
    }
    throw err;
  }
};

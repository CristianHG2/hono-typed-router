import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The value that `rethrow()` returns. The export lets the declarations of a consumer name its
 * `unique symbol` type.
 * @deprecated Return rethrow() from the arm. Removed in 2.0.
 */
export const RETHROW: unique symbol = Symbol('RETHROW');

/** The type of the value that `rethrow()` returns. */
export type Rethrow = typeof RETHROW;

const RETHROW_SENTINEL: Rethrow = RETHROW;

/**
 * One error arm: it matches an error that is `instanceof ctor` and runs `handle`. The handler
 * returns a response (`TResult`), or `rethrow()` to pass the error to the next arm.
 */
export type ErrorArm<TErr extends Error, TResult> = Readonly<{
  ctor: new (...args: any[]) => TErr;
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>;
}>;

/**
 * Declares an error arm. TypeScript infers `TResult` from the return of the handler, for
 * example a `TypedResponse` from `c.json(body, status)`. `handle(c, fn, arms)` and
 * `handleErrors` add this type to their return type.
 */
export function onError<TErr extends Error, TResult>(
  ctor: new (...args: any[]) => TErr,
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>,
): ErrorArm<TErr, TResult> {
  return { ctor, handle };
}

/** @deprecated Use {@link onError}. Removed in 2.0. */
export const on = onError;

/** Passes the error to the next matching arm. If no arm matches, the error is thrown again. */
export function rethrow(): Rethrow {
  return RETHROW_SENTINEL;
}

/** An arm handler that responds with `{ message }` and the status `statusCode`. */
export function genericErrorHandler<T extends ContentfulStatusCode>(statusCode: T) {
  return (err: Error, c: Context) => c.json({ message: err.message }, statusCode);
}

/** @internal */
export type AnyArm = ErrorArm<any, any>;

// `async () => rethrow()` widens `Rethrow` to `symbol`, so this excludes all of `symbol`.
type ArmResponse<TArm> =
  TArm extends ErrorArm<any, infer TResult> ? Exclude<Awaited<TResult>, symbol> : never;

/** @internal */
export type ArmsResponse<TArms extends ReadonlyArray<AnyArm>> = ArmResponse<TArms[number]>;

// A module-level error object keeps the `cause` of its first throw.
async function runArm(
  arm: AnyArm,
  err: Error,
  c: Context,
): Promise<Awaited<ReturnType<AnyArm['handle']>>> {
  try {
    return await arm.handle(err, c);
  } catch (thrown) {
    if (
      thrown instanceof Error &&
      thrown !== err &&
      thrown.cause === undefined &&
      Object.isExtensible(thrown)
    ) {
      try {
        thrown.cause = err;
      } catch {
        // A setter or a read-only `cause` on the prototype can throw. Keep the error of the handler.
      }
    }

    throw thrown;
  }
}

/**
 * Runs `body()`. The first arm that matches a thrown `Error` by `instanceof` handles it, and an
 * arm that returns `rethrow()` passes it to the next arm. If no arm handles the error, or the
 * thrown value is not an `Error`, it is thrown again.
 */
export async function handleErrors<TBody, const TArms extends ReadonlyArray<AnyArm>>(
  body: () => Promise<TBody>,
  arms: TArms,
  c: Context,
): Promise<TBody | ArmsResponse<TArms>> {
  try {
    return await body();
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }

    for (const arm of arms) {
      if (!(err instanceof arm.ctor)) {
        continue;
      }

      const result = await runArm(arm, err, c);

      if (result === RETHROW_SENTINEL) {
        continue;
      }

      return result;
    }

    throw err;
  }
}

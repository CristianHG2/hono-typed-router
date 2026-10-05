import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Sentinel that `rethrow()` returns, compared by identity. It is exported so that the
 * declaration emit of a consumer can name its `unique symbol` type.
 * @deprecated Return rethrow() from the arm. Removed in 2.0.
 */
export const RETHROW: unique symbol = Symbol('RETHROW');

/** The type of the value that `rethrow()` returns. */
export type Rethrow = typeof RETHROW;

const RETHROW_SENTINEL: Rethrow = RETHROW;

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
 * `c.json(body, status)`). That precision is what lets `handle(c, fn, arms)` and
 * `handleErrors(...)` widen their return type with the arms' responses.
 */
export const onError = <TErr extends Error, TResult>(
  ctor: new (...args: any[]) => TErr,
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>,
): ErrorArm<TErr, TResult> => ({ ctor, handle });

/** @deprecated Use {@link onError}. Removed in 2.0. */
export const on = onError;

/** Declines the error from an arm: the next matching arm runs, or the error is rethrown. */
export const rethrow = (): Rethrow => RETHROW_SENTINEL;

/** Convenience arm handler: respond with `{ message }` at the given status. */
export const genericErrorHandler =
  <T extends ContentfulStatusCode>(statusCode: T) =>
  (err: Error, c: Context) =>
    c.json({ message: err.message }, statusCode);

/**
 * Any error arm, whatever error it matches and response it produces.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type AnyArm = ErrorArm<any, any>;

// `async () => rethrow()` widens the sentinel to `symbol`, so the whole primitive is excluded.
type ArmResponse<TArm> =
  TArm extends ErrorArm<any, infer TResult> ? Exclude<Awaited<TResult>, symbol> : never;

/**
 * Union of the response types produced by a tuple of arms (sans `Rethrow`).
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ArmsResponse<TArms extends ReadonlyArray<AnyArm>> = ArmResponse<TArms[number]>;

/**
 * Runs the handler of an arm. If the handler throws an `Error` that has no `cause`, the
 * original error becomes its `cause`, so the error log shows both errors. A frozen or sealed
 * error, or one whose `cause` cannot be set, is rethrown unchanged. A module-level singleton
 * error keeps the `cause` of its first throw.
 */
const runArm = async (
  arm: AnyArm,
  err: Error,
  c: Context,
): Promise<Awaited<ReturnType<AnyArm['handle']>>> => {
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
        // A setter or a non-writable `cause` on the prototype rejects the value. Rethrow the
        // error that the handler threw, not this one.
      }
    }

    throw thrown;
  }
};

/**
 * Runs `body()` and, if it throws an `Error`, dispatches to the first matching
 * arm (by `instanceof`). Arms are tried in order; an arm returning `rethrow()`
 * falls through to the next. If no arm matches (or all rethrow), the error is
 * rethrown. Non-`Error` throws bypass the arms entirely. An `Error` that an arm handler
 * throws gets the original error as its `cause`, if it has no `cause`.
 *
 * The return type is `TBody` widened with every arm's response type (minus the
 * `Rethrow` sentinel), so callers see the full set of responses the route can
 * produce.
 */
export const handleErrors = async <TBody, const TArms extends ReadonlyArray<AnyArm>>(
  body: () => Promise<TBody>,
  arms: TArms,
  c: Context,
): Promise<TBody | ArmsResponse<TArms>> => {
  try {
    return await body();
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }

    for (const arm of arms) {
      if (err instanceof arm.ctor) {
        const result = await runArm(arm, err, c);

        if (result === RETHROW_SENTINEL) {
          continue;
        }

        return result;
      }
    }

    throw err;
  }
};

/**
 * An `Error` subclass constructor that `matchErrors` can dispatch on.
 */
export type ErrorCtor = new (...args: any[]) => Error;

// A tag must be a string literal: `string` itself (e.g. `Error.prototype.name`) does not count.
type LiteralTag<T> = T extends string ? (string extends T ? never : T) : never;

type UnderscoreTag<TErr> = TErr extends { readonly _tag: infer T } ? LiteralTag<T> : never;

type NameTag<TErr> = TErr extends { readonly name: infer T } ? LiteralTag<T> : never;

/**
 * The handler key of an error class: its instance's string-literal `_tag`, else its
 * string-literal `name` (declare it as `override readonly name = 'X' as const`), else
 * `never` (and `matchErrors` rejects the class).
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ErrorTag<TCtor extends ErrorCtor> = TCtor extends ErrorCtor
  ? [UnderscoreTag<InstanceType<TCtor>>] extends [never]
    ? NameTag<InstanceType<TCtor>>
    : UnderscoreTag<InstanceType<TCtor>>
  : never;

// Tags that occur more than once in the class list (`Tag & Seen` is the tag if already seen).
type DuplicateTags<
  TCtors extends readonly ErrorCtor[],
  TSeen extends string = never,
  TDuplicate extends string = never,
> = TCtors extends readonly [
  infer THead extends ErrorCtor,
  ...infer TRest extends readonly ErrorCtor[],
]
  ? DuplicateTags<TRest, TSeen | ErrorTag<THead>, TDuplicate | (ErrorTag<THead> & TSeen)>
  : TDuplicate;

// Replaces each invalid class with a readable error string, so the call site reports it.
type CheckErrorCtors<TCtors extends readonly ErrorCtor[]> = {
  readonly [I in keyof TCtors]: TCtors[I] extends ErrorCtor
    ? [ErrorTag<TCtors[I]>] extends [never]
      ? `Error class at index ${I & string} needs a literal _tag or name`
      : [ErrorTag<TCtors[I]> & DuplicateTags<TCtors>] extends [never]
        ? TCtors[I]
        : `Error class at index ${I & string} shares the tag "${ErrorTag<TCtors[I]>}" with another class`
    : TCtors[I];
};

/**
 * One handler per error class, keyed by its {@link ErrorTag}. Every key is required and no
 * other key is allowed. A handler has the same shape as an {@link onError} handler.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type MatchHandlers<TCtors extends readonly ErrorCtor[]> = {
  readonly [TCtor in TCtors[number] as ErrorTag<TCtor>]: (
    err: InstanceType<TCtor>,
    c: Context,
  ) => any;
};

// The tags of a class tuple, in order, joined by `, `. A union in a template literal type
// gives one string per member, so the tuple is walked instead.
type JoinTags<TCtors extends readonly unknown[]> = TCtors extends readonly [
  infer THead extends ErrorCtor,
  ...infer TRest,
]
  ? TRest extends readonly []
    ? `${ErrorTag<THead>}`
    : `${ErrorTag<THead>}, ${JoinTags<TRest>}`
  : string;

// A key that is not a listed tag gets a message type, so the error names the valid tags.
type NoExtraKeys<TCtors extends readonly ErrorCtor[], THandlers> = {
  readonly [
    K in Exclude<keyof THandlers, ErrorTag<TCtors[number]>>
  ]: `"${K & string}" is not the tag of a listed class. The tags are: ${JoinTags<TCtors>}`;
};

type HandlerResponse<THandler> = THandler extends (...args: any[]) => infer TResult
  ? Exclude<Awaited<TResult>, symbol>
  : never;

type MatchArms<TCtors extends readonly ErrorCtor[], THandlers> = {
  readonly [I in keyof TCtors]: TCtors[I] extends ErrorCtor
    ? ErrorArm<
        InstanceType<TCtors[I]>,
        HandlerResponse<THandlers[ErrorTag<TCtors[I]> & keyof THandlers]>
      >
    : never;
};

type LooseHandler = (err: Error, c: Context) => ReturnType<AnyArm['handle']>;

// Read through a constant: `no-underscore-dangle` rejects the `._tag` member access.
const TAG_KEY = '_tag';

/**
 * Declares one error arm per class in `errors`, with an exhaustive handler map keyed by
 * each class's {@link ErrorTag}. The result is an arm tuple: pass it to `handle(c, fn, ...)`
 * or `handleErrors`, or spread it next to `onError` arms.
 *
 * An error that is `instanceof` any class in `errors` is handled by the handler keyed by
 * its runtime tag (`_tag` if `handlers` has that key, else `name`); the order of `errors`
 * does not matter. Do not reuse a tag across unrelated classes: a subclass that declares
 * another listed class's `_tag` goes to that class's handler.
 * A handler that returns `rethrow()` passes the error to the next arm after this tuple.
 *
 * ```ts
 * handle(c, fn, matchErrors([CartNotFound, OutOfStock], {
 *   CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
 *   OutOfStock: (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
 * }));
 * ```
 */
export const matchErrors = <
  const TCtors extends readonly ErrorCtor[],
  THandlers extends MatchHandlers<TCtors> & NoExtraKeys<TCtors, THandlers>,
>(
  errors: TCtors & CheckErrorCtors<TCtors>,
  handlers: THandlers,
): MatchArms<TCtors, THandlers> => {
  const ctors: readonly ErrorCtor[] = errors;
  // SAFETY: every value is a handler for some `Error` subclass. A handler only runs for an
  // error that is `instanceof` a listed class and whose runtime `_tag`/`name` equals its key;
  // the literal-tag constraint makes that an instance of the key's class (or a subclass).
  // Only a subclass that sets another listed class's tag at runtime could break this.
  const table = new Map(Object.entries(handlers) as Array<[string, LooseHandler]>);

  // `_tag` wins when it names a handler (only a string can equal a key); else `name`.
  const resolve = (err: Error): LooseHandler | undefined => {
    const tag = TAG_KEY in err ? err[TAG_KEY] : undefined;

    for (const [key, handler] of table) {
      if (key === tag) {
        return handler;
      }
    }

    return table.get(err.name);
  };

  const arms = ctors.map((ctor, index) =>
    onError(ctor, (err, c) => {
      // Only one arm of the tuple runs (the first listed class the error matches), so a
      // rethrow falls past the rest of this tuple instead of re-running the same handler.
      // The handler is picked by the error's tag, not by this arm's index.
      if (ctors.findIndex((candidate) => err instanceof candidate) !== index) {
        return RETHROW_SENTINEL;
      }

      const handler = resolve(err);

      return handler === undefined ? RETHROW_SENTINEL : handler(err, c);
    }),
  );

  // SAFETY: `arms[i]` matches `errors[i]` and runs the handler keyed by its tag, which is the
  // element type `MatchArms` assigns to index `i`.
  return arms as MatchArms<TCtors, THandlers>;
};

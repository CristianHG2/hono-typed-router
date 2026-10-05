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
export const onError = <TErr extends Error, TResult>(
  ctor: new (...args: any[]) => TErr,
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>,
): ErrorArm<TErr, TResult> => ({ ctor, handle });

/** @deprecated Use {@link onError}. Removed in 2.0. */
export const on = onError;

/** Passes the error to the next matching arm. If no arm matches, the error is thrown again. */
export const rethrow = (): Rethrow => RETHROW_SENTINEL;

/** An arm handler that responds with `{ message }` and the status `statusCode`. */
export const genericErrorHandler =
  <T extends ContentfulStatusCode>(statusCode: T) =>
  (err: Error, c: Context) =>
    c.json({ message: err.message }, statusCode);

/** @internal Any error arm. */
export type AnyArm = ErrorArm<any, any>;

// `async () => rethrow()` widens `Rethrow` to `symbol`, so this excludes all of `symbol`.
type ArmResponse<TArm> =
  TArm extends ErrorArm<any, infer TResult> ? Exclude<Awaited<TResult>, symbol> : never;

/** @internal The union of the response types of the arms, without `Rethrow`. */
export type ArmsResponse<TArms extends ReadonlyArray<AnyArm>> = ArmResponse<TArms[number]>;

/**
 * Runs the handler of an arm. If the handler throws an `Error` without a `cause`, the original
 * error becomes its `cause`. A frozen or sealed error is thrown unchanged. A module-level
 * error object keeps the `cause` of its first throw.
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
        // A setter or a read-only `cause` on the prototype can throw. Throw the error of the
        // handler, not this one.
      }
    }

    throw thrown;
  }
};

/**
 * Runs `body()`. If it throws an `Error`, the first arm that matches by `instanceof` handles
 * it. An arm that returns `rethrow()` passes the error to the next arm. If no arm handles the
 * error, it is thrown again. A thrown value that is not an `Error` skips the arms. An `Error`
 * that an arm throws gets the original error as its `cause` when it has no `cause`. The return
 * type is `TBody` plus the response type of each arm.
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

/** The constructor of an `Error` subclass, for `matchErrors`. */
export type ErrorCtor = new (...args: any[]) => Error;

// A tag is a string literal. `string` (for example `Error.prototype.name`) is not a tag.
type LiteralTag<T> = T extends string ? (string extends T ? never : T) : never;

type UnderscoreTag<TErr> = TErr extends { readonly _tag: infer T } ? LiteralTag<T> : never;

type NameTag<TErr> = TErr extends { readonly name: infer T } ? LiteralTag<T> : never;

/**
 * @internal The handler key of an error class: the literal `_tag` of an instance, else the
 * literal `name` (`override readonly name = 'X' as const`), else `never`.
 */
export type ErrorTag<TCtor extends ErrorCtor> = TCtor extends ErrorCtor
  ? [UnderscoreTag<InstanceType<TCtor>>] extends [never]
    ? NameTag<InstanceType<TCtor>>
    : UnderscoreTag<InstanceType<TCtor>>
  : never;

// The tags that occur more than once. `Tag & Seen` is the tag when it occurred before.
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

// Replaces each class that is not valid with an error string that the call site shows.
type CheckErrorCtors<TCtors extends readonly ErrorCtor[]> = {
  readonly [I in keyof TCtors]: TCtors[I] extends ErrorCtor
    ? [ErrorTag<TCtors[I]>] extends [never]
      ? `Error class at index ${I & string} needs a literal _tag or name`
      : [ErrorTag<TCtors[I]> & DuplicateTags<TCtors>] extends [never]
        ? TCtors[I]
        : `Error class at index ${I & string} shares the tag "${ErrorTag<TCtors[I]>}" with another class`
    : TCtors[I];
};

/** @internal One handler for each error class, with its {@link ErrorTag} as the key. */
export type MatchHandlers<TCtors extends readonly ErrorCtor[]> = {
  readonly [TCtor in TCtors[number] as ErrorTag<TCtor>]: (
    err: InstanceType<TCtor>,
    c: Context,
  ) => any;
};

// Walks the tuple, because a union in a template literal type gives one string per member.
type JoinTags<TCtors extends readonly unknown[]> = TCtors extends readonly [
  infer THead extends ErrorCtor,
  ...infer TRest,
]
  ? TRest extends readonly []
    ? `${ErrorTag<THead>}`
    : `${ErrorTag<THead>}, ${JoinTags<TRest>}`
  : string;

// The type of an extra key is a message that names the valid tags.
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

// `no-underscore-dangle` rejects `err._tag`.
const TAG_KEY = '_tag';

/**
 * Declares one error arm for each class in `errors`. `handlers` has one handler for each
 * {@link ErrorTag}, and no other key. Pass the result to `handle(c, fn, ...)` or
 * `handleErrors`, or spread it next to `onError` arms.
 *
 * The runtime tag of the error selects the handler: `_tag` when `handlers` has that key, else
 * `name`. The order of `errors` has no effect. Do not use one tag on two unrelated classes. A
 * handler that returns `rethrow()` passes the error to the next arm after this tuple.
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
  // SAFETY: a handler runs only for an error that is `instanceof` a listed class and whose
  // runtime tag equals its key. The literal tags make that error an instance of the class of
  // the key. A subclass that sets the tag of another listed class breaks this.
  const table = new Map(Object.entries(handlers) as Array<[string, LooseHandler]>);

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
      // Only the first arm that matches runs. Thus `rethrow()` skips the rest of the tuple and
      // does not run the same handler again.
      if (ctors.findIndex((candidate) => err instanceof candidate) !== index) {
        return RETHROW_SENTINEL;
      }

      const handler = resolve(err);

      return handler === undefined ? RETHROW_SENTINEL : handler(err, c);
    }),
  );

  // SAFETY: `arms[i]` matches `errors[i]` and runs the handler of its tag. `MatchArms` gives
  // index `i` that type.
  return arms as MatchArms<TCtors, THandlers>;
};

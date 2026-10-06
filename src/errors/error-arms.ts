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

export type ErrorCtor = new (...args: any[]) => Error;

// `string`, the type of `Error.prototype.name`, is not a tag.
type LiteralTag<T> = T extends string ? (string extends T ? never : T) : never;

type UnderscoreTag<TErr> = TErr extends { readonly _tag: infer T } ? LiteralTag<T> : never;

type NameTag<TErr> = TErr extends { readonly name: infer T } ? LiteralTag<T> : never;

/** @internal */
export type ErrorTag<TCtor extends ErrorCtor> = TCtor extends ErrorCtor
  ? [UnderscoreTag<InstanceType<TCtor>>] extends [never]
    ? NameTag<InstanceType<TCtor>>
    : UnderscoreTag<InstanceType<TCtor>>
  : never;

// `ErrorTag<THead> & TSeen` is the tag when an earlier class has it, else `never`.
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

/** @internal */
export type CheckErrorCtors<TCtors extends readonly ErrorCtor[]> = {
  readonly [I in keyof TCtors]: TCtors[I] extends ErrorCtor
    ? [ErrorTag<TCtors[I]>] extends [never]
      ? `Error class at index ${I & string} needs a literal _tag or name`
      : [ErrorTag<TCtors[I]> & DuplicateTags<TCtors>] extends [never]
        ? TCtors[I]
        : `Error class at index ${I & string} shares the tag "${ErrorTag<TCtors[I]>}" with another class`
    : TCtors[I];
};

/** @internal */
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
 * Declares one error arm for each class in `errors`. `handlers` has one handler for each tag:
 * the literal `_tag` of the class, else its literal `name`. Do not use one tag on two unrelated
 * classes.
 */
export function matchErrors<
  const TCtors extends readonly ErrorCtor[],
  THandlers extends MatchHandlers<TCtors> & NoExtraKeys<TCtors, THandlers>,
>(errors: TCtors & CheckErrorCtors<TCtors>, handlers: THandlers): MatchArms<TCtors, THandlers> {
  const ctors: readonly ErrorCtor[] = errors;
  // SAFETY: a handler runs only for an error that is `instanceof` a listed class and has the tag
  // of its key, so the error is an instance of the class of the key. A subclass that sets the
  // tag of another listed class breaks this.
  const table = new Map(Object.entries(handlers) as Array<[string, LooseHandler]>);

  function resolve(err: Error): LooseHandler | undefined {
    const tag = TAG_KEY in err ? err[TAG_KEY] : undefined;

    for (const [key, handler] of table) {
      if (key === tag) {
        return handler;
      }
    }

    return table.get(err.name);
  }

  const arms = ctors.map((ctor, index) =>
    onError(ctor, (err, c) => {
      // Only the first matching arm of the tuple runs, so `rethrow()` does not run the same
      // handler again.
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
}

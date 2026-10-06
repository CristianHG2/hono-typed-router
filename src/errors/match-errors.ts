import type { Context } from 'hono';
import { onError, rethrow } from './error-arms';
import type { AnyArm, ErrorArm } from './error-arms';

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
        return rethrow();
      }

      const handler = resolve(err);

      return handler === undefined ? rethrow() : handler(err, c);
    }),
  );

  // SAFETY: `arms[i]` matches `errors[i]` and runs the handler of its tag. `MatchArms` gives
  // index `i` that type.
  return arms as MatchArms<TCtors, THandlers>;
}

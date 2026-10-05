import type { HandlerBindings, HandlerReads, HandlerSets } from './env';

/**
 * The intersection of the vars that each middleware of the array sets. A non-tuple array
 * gives the vars of its element type. An empty array gives `{}`.
 *
 * @internal Exported for declaration emit.
 */
// The trailing-element branch must come before the `readonly []` branch. `[...list, a]`
// infers to `[...MiddlewareHandler[], typeof a]`, and the head branch does not match it.
// An empty `[...TMws]` infers to `never[]`, so a `never` element type gives `{}`.
export type FoldVars<TMws extends readonly unknown[]> = TMws extends readonly [
  infer THead,
  ...infer TRest,
]
  ? HandlerSets<THead> & FoldVars<TRest>
  : TMws extends readonly [...infer TInit, infer TLast]
    ? FoldVars<TInit> & HandlerSets<TLast>
    : TMws extends readonly []
      ? {}
      : [TMws[number]] extends [never]
        ? {}
        : HandlerSets<TMws[number]>;

/**
 * {@link FoldVars} for the `Bindings` of each middleware.
 *
 * @internal Exported for declaration emit.
 */
export type FoldBindings<TMws extends readonly unknown[]> = TMws extends readonly [
  infer THead,
  ...infer TRest,
]
  ? HandlerBindings<THead> & FoldBindings<TRest>
  : TMws extends readonly [...infer TInit, infer TLast]
    ? FoldBindings<TInit> & HandlerBindings<TLast>
    : TMws extends readonly []
      ? {}
      : [TMws[number]] extends [never]
        ? {}
        : HandlerBindings<TMws[number]>;

/** The check ignores the order of the middlewares in the array. */
type CheckRootReads<TMws extends readonly unknown[]> = [
  Exclude<ReadKeys<TMws[number]>, keyof FoldVars<TMws>>,
] extends [never]
  ? unknown
  : `This middleware reads vars that the root context does not have: ${Exclude<ReadKeys<TMws[number]>, keyof FoldVars<TMws>> & string}`;

// Distributes over the union, because `keyof` of a union gives only the common keys.
type ReadKeys<THandler> = THandler extends unknown ? keyof HandlerReads<THandler> : never;

/** The element type of `list` in `[...list, a]`. A tuple without a spread gives `never`. */
type RestElement<TMws extends readonly unknown[]> = TMws extends readonly [unknown, ...infer TRest]
  ? RestElement<TRest>
  : TMws extends readonly [...infer TInit, unknown]
    ? RestElement<TInit>
    : TMws[number];

/** `true` if the union `TSets` has two different members. */
type IsMixed<TSets, TAll = TSets> = true extends (
  TSets extends unknown ? ([TAll] extends [TSets] ? false : true) : never
)
  ? true
  : false;

type Kind = 'var' | 'binding';

type Declared<THandler, TKind extends Kind> = TKind extends 'var'
  ? HandlerSets<THandler>
  : HandlerBindings<THandler>;

type Fold<TMws extends readonly unknown[], TKind extends Kind> = TKind extends 'var'
  ? FoldVars<TMws>
  : FoldBindings<TMws>;

/**
 * The keys that two middlewares of the array declare with different types. A type is
 * assignable to the folded intersection only when all the types are the same. Two literal
 * types of one key (`{ kind: 'a' }` and `{ kind: 'b' }`) make the fold `never`. Then each
 * pair of middlewares is compared, so the error shows only the conflicting keys.
 */
type ConflictKeys<
  TMws extends readonly unknown[],
  TKind extends Kind,
  TFold = Fold<TMws, TKind>,
> = [TFold] extends [never]
  ? PairConflictKeys<TMws[number], TKind>
  : TMws[number] extends infer THandler
    ? THandler extends unknown
      ? ConflictKeysOf<Declared<THandler, TKind>, TFold>
      : never
    : never;

type ConflictKeysOf<TSets, TFold> = {
  [K in keyof TSets]-?: [TSets[K]] extends [TFold[K & keyof TFold]] ? never : K;
}[keyof TSets];

type PairConflictKeys<THandler, TKind extends Kind, TOther = THandler> = THandler extends unknown
  ? TOther extends unknown
    ? DiffKeys<Declared<THandler, TKind>, Declared<TOther, TKind>>
    : never
  : never;

type DiffKeys<TA, TB> = {
  [K in keyof TA & keyof TB]-?: [TA[K]] extends [TB[K]] ? ([TB[K]] extends [TA[K]] ? never : K) : K;
}[keyof TA & keyof TB];

/**
 * Rejects a non-tuple array of middlewares with different vars, because the fold gives a
 * union of the vars for it. Also rejects a var or a binding with two different types, and a read var
 * that no middleware of the array sets.
 *
 * @internal Exported for declaration emit.
 */
export type CheckRootArray<TMws extends readonly unknown[]> = number extends TMws['length']
  ? IsMixed<HandlerSets<RestElement<TMws>>> extends true
    ? 'Pass the middlewares as a tuple literal or as const: an array variable with mixed middlewares has one union element type'
    : CheckRootConflicts<TMws>
  : CheckRootConflicts<TMws>;

type CheckRootConflicts<TMws extends readonly unknown[]> = [ConflictKeys<TMws, 'var'>] extends [
  never,
]
  ? CheckRootBindings<TMws>
  : `Middlewares in the array declare the same var with different types: ${ConflictKeys<TMws, 'var'> & string}`;

type CheckRootBindings<TMws extends readonly unknown[]> = [ConflictKeys<TMws, 'binding'>] extends [
  never,
]
  ? CheckRootReads<TMws>
  : `Middlewares in the array declare the same binding with different types: ${ConflictKeys<TMws, 'binding'> & string}`;

import type { HandlerBindings, HandlerReads, HandlerSets } from './env';

// The types of the fold signature of `defineRootContext`: the vars of a root array, and the
// checks of the array.

/**
 * The intersection of the vars that each middleware in a tuple sets (see
 * {@link HandlerSets}). A tuple with a spread, such as `[...list, a]`, gives the vars of its
 * fixed elements and of the spread element type. A non-tuple array gives the vars of its
 * element type, and an empty array gives `{}`. A `ContextEnv` middleware adds only the vars
 * that it sets; the vars that it reads must come from the other middlewares of the array.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
// `never[]` is what an empty `[...TMws]` infers to, so a `never` element type gives `{}`.
// The trailing-element branch must come before the `readonly []` check: `[...list, a]`
// infers to `[...MiddlewareHandler[], typeof a]`, which the head branch does not match.
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
 * The intersection of the `Bindings` that each middleware in a tuple declares (see
 * {@link HandlerBindings}). The tuple forms are the same as for {@link FoldVars}.
 *
 * @internal Exported for declaration emit; not part of the public API.
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

/**
 * `unknown`, or a message when a `ContextEnv` middleware in a root array reads a var that no
 * middleware of the array sets. The order in the array is not checked.
 */
type CheckRootReads<TMws extends readonly unknown[]> = [
  Exclude<ReadKeys<TMws[number]>, keyof FoldVars<TMws>>,
] extends [never]
  ? unknown
  : `This middleware reads vars that the root context does not have: ${Exclude<ReadKeys<TMws[number]>, keyof FoldVars<TMws>> & string}`;

// Distributes over a union of middlewares: `keyof` of a union gives only the common keys.
type ReadKeys<THandler> = THandler extends unknown ? keyof HandlerReads<THandler> : never;

/**
 * The element type of the non-tuple part of an array: of `list` in `[...list, a]`, or of the
 * whole array for a `T[]`. A tuple without a spread gives `never`.
 */
type RestElement<TMws extends readonly unknown[]> = TMws extends readonly [unknown, ...infer TRest]
  ? RestElement<TRest>
  : TMws extends readonly [...infer TInit, unknown]
    ? RestElement<TInit>
    : TMws[number];

/**
 * `true` if the union `TSets` has two members that are not the same type. `TAll` is the full
 * union; the check distributes over `TSets`.
 */
type IsMixed<TSets, TAll = TSets> = true extends (
  TSets extends unknown ? ([TAll] extends [TSets] ? false : true) : never
)
  ? true
  : false;

/** What a conflict check compares: the vars that a middleware sets, or its bindings. */
type Kind = 'var' | 'binding';

type Declared<THandler, TKind extends Kind> = TKind extends 'var'
  ? HandlerSets<THandler>
  : HandlerBindings<THandler>;

type Fold<TMws extends readonly unknown[], TKind extends Kind> = TKind extends 'var'
  ? FoldVars<TMws>
  : FoldBindings<TMws>;

/**
 * The keys that two middlewares of the array declare with different types: vars for
 * `'var'`, bindings for `'binding'`. A middleware's type of a key must be assignable to the
 * folded type (the intersection of all its types), which is true only when all the types are
 * the same. When the fold is `never` (two literal types of one key, such as `{ kind: 'a' }`
 * and `{ kind: 'b' }`), each pair of middlewares is compared instead, so that only the
 * conflicting keys show.
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
 * `unknown`, or a message when the fold cannot type the root array:
 *
 * - The array is not a tuple, and its element type is a union of middlewares with different
 *   vars (`const list = [a, b]`). The fold would give a union of the vars.
 * - Two middlewares set the same var with different types. The same type is allowed.
 * - Two middlewares declare the same binding with different types. The same type is allowed.
 * - A `ContextEnv` middleware reads a var that no middleware of the array sets.
 *
 * @internal Exported for declaration emit; not part of the public API.
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

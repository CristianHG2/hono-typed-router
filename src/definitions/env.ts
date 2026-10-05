import type { MiddlewareHandler } from 'hono';

// The types that read the `Env` of a middleware: its vars, the vars that it reads and sets,
// its bindings, and the check of its fit on a context.

/**
 * Type-only key that `ContextEnv` puts on an `Env`: the vars that the middleware reads
 * from its context. `.middleware()` and the root array use it to tell the vars that a
 * middleware reads from the vars that it sets. No runtime value has this key.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export declare const READS: unique symbol;

/**
 * Type-only key that `ContextEnv` puts on an `Env`: the vars that the middleware sets.
 * `.middleware()` and the root array read the set vars from this key, not from
 * `Omit<Variables, keyof reads>`. An `Omit` makes each context in a chain of `ContextEnv`
 * middlewares contain the `Omit` of the previous context, and the check time grows
 * exponentially with the chain length. No runtime value has this key.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export declare const SETS: unique symbol;

/** `true` if `T` is `any`. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** The `Env` of a middleware, or `never` if `THandler` is not a middleware. */
type HandlerEnv<THandler> = THandler extends MiddlewareHandler<infer E, any, any> ? E : never;

/** The `Variables` of an `Env`. An untyped `Env` (`any`, or `any` variables) gives `{}`. */
type EnvVars<E> =
  IsAny<E> extends true
    ? {}
    : E extends { Variables: infer V extends object }
      ? IsAny<V> extends true
        ? {}
        : V
      : {};

/** The `Bindings` of an `Env`. An untyped `Env` (`any`, or `any` bindings) gives `{}`. */
type EnvBindings<E> =
  IsAny<E> extends true
    ? {}
    : E extends { Bindings: infer B extends object }
      ? IsAny<B> extends true
        ? {}
        : B
      : {};

/** The vars that an `Env` built with `ContextEnv` reads. Any other `Env` gives `{}`. */
type EnvReads<E> =
  IsAny<E> extends true ? {} : E extends { readonly [READS]: infer R extends object } ? R : {};

/**
 * The vars that an `Env` sets: the {@link SETS} key of a `ContextEnv` `Env`. Any other `Env`
 * sets all its `Variables`.
 */
type EnvSets<E> =
  IsAny<E> extends true
    ? {}
    : E extends { readonly [SETS]: infer N extends object }
      ? N
      : EnvVars<E>;

/**
 * The `Variables` that a middleware declares. An untyped handler (`Env` or `any`
 * variables) gives `{}`.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerVars<THandler> = EnvVars<HandlerEnv<THandler>>;

/**
 * The vars that a middleware reads from its context (`{}` if not built with `ContextEnv`).
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerReads<THandler> = EnvReads<HandlerEnv<THandler>>;

/**
 * The vars that a middleware sets: its `Variables` without the vars that it reads.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerSets<THandler> = EnvSets<HandlerEnv<THandler>>;

/**
 * The `Bindings` that a middleware declares. An untyped handler (`Env` or `any` bindings)
 * gives `{}`.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerBindings<THandler> = EnvBindings<HandlerEnv<THandler>>;

/**
 * `unknown` when a typed middleware with `Env` `E` fits a context with vars `TVars`, else a
 * message. It fits when the context has each var that the middleware reads, and the
 * middleware sets no var that the context has. The bindings are not checked.
 */
type CheckEnvFits<E, TVars> = [Exclude<keyof EnvReads<E>, keyof TVars>] extends [never]
  ? [Extract<keyof EnvSets<E>, keyof TVars>] extends [never]
    ? unknown
    : `Cannot redeclare existing var: ${Extract<keyof EnvSets<E>, keyof TVars> & string}`
  : `This middleware reads vars that the context does not have: ${Exclude<keyof EnvReads<E>, keyof TVars> & string}`;

/**
 * {@link CheckEnvFits} for a middleware.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type CheckMiddlewareFits<THandler, TVars> = CheckEnvFits<HandlerEnv<THandler>, TVars>;

/**
 * The Hono `Env` of an app with the vars `V` and the bindings `B`. Empty bindings give
 * `{ Variables: V }`, so an app without bindings has the same type as before bindings
 * existed. Use it only where the exact type shows: in a parameter, `{ Bindings: B;
 * Variables: V }` infers better.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type RouterEnv<V extends object, B extends object> = [keyof B] extends [never]
  ? { Variables: V }
  : { Bindings: B; Variables: V };

/**
 * The bindings of a context: its `bindings` phantom, or `{}` for a `{ path; vars }` shape
 * without one.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ContextBindings<TContext> = TContext extends { bindings: infer B extends object }
  ? B
  : {};

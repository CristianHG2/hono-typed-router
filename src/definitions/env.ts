import type { MiddlewareHandler } from 'hono';

/**
 * Type-only key that `ContextEnv` puts on an `Env`. It holds the vars that the middleware
 * reads from its context.
 *
 * @internal Exported for declaration emit.
 */
export declare const READS: unique symbol;

/**
 * Type-only key that `ContextEnv` puts on an `Env`. It holds the vars that the middleware
 * sets. Do not replace it with `Omit<Variables, keyof reads>`. With `Omit`, each context in
 * a chain of `ContextEnv` middlewares contains the `Omit` of the previous context. The check
 * time then grows exponentially with the chain length.
 *
 * @internal Exported for declaration emit.
 */
export declare const SETS: unique symbol;

type IsAny<T> = 0 extends 1 & T ? true : false;

type HandlerEnv<THandler> = THandler extends MiddlewareHandler<infer E, any, any> ? E : never;

/** An untyped `Env` (`any`, or `any` variables) gives `{}`. */
type EnvVars<E> =
  IsAny<E> extends true
    ? {}
    : E extends { Variables: infer V extends object }
      ? IsAny<V> extends true
        ? {}
        : V
      : {};

/** An untyped `Env` (`any`, or `any` bindings) gives `{}`. */
type EnvBindings<E> =
  IsAny<E> extends true
    ? {}
    : E extends { Bindings: infer B extends object }
      ? IsAny<B> extends true
        ? {}
        : B
      : {};

type EnvReads<E> =
  IsAny<E> extends true ? {} : E extends { readonly [READS]: infer R extends object } ? R : {};

/** An `Env` without the {@link SETS} key sets all its `Variables`. */
type EnvSets<E> =
  IsAny<E> extends true
    ? {}
    : E extends { readonly [SETS]: infer N extends object }
      ? N
      : EnvVars<E>;

/** @internal Exported for declaration emit. */
export type HandlerVars<THandler> = EnvVars<HandlerEnv<THandler>>;

/** @internal Exported for declaration emit. */
export type HandlerReads<THandler> = EnvReads<HandlerEnv<THandler>>;

/** @internal Exported for declaration emit. */
export type HandlerSets<THandler> = EnvSets<HandlerEnv<THandler>>;

/** @internal Exported for declaration emit. */
export type HandlerBindings<THandler> = EnvBindings<HandlerEnv<THandler>>;

/** The check ignores the bindings. */
type CheckEnvFits<E, TVars> = [Exclude<keyof EnvReads<E>, keyof TVars>] extends [never]
  ? [Extract<keyof EnvSets<E>, keyof TVars>] extends [never]
    ? unknown
    : `Cannot redeclare existing var: ${Extract<keyof EnvSets<E>, keyof TVars> & string}`
  : `This middleware reads vars that the context does not have: ${Exclude<keyof EnvReads<E>, keyof TVars> & string}`;

/** @internal Exported for declaration emit. */
export type CheckMiddlewareFits<THandler, TVars> = CheckEnvFits<HandlerEnv<THandler>, TVars>;

/**
 * Empty bindings give `{ Variables: V }`. Use this type only where the exact type shows. In
 * a parameter, `{ Bindings: B; Variables: V }` infers better.
 *
 * @internal Exported for declaration emit.
 */
export type RouterEnv<V extends object, B extends object> = [keyof B] extends [never]
  ? { Variables: V }
  : { Bindings: B; Variables: V };

/** @internal Exported for declaration emit. */
export type ContextBindings<TContext> = TContext extends { bindings: infer B extends object }
  ? B
  : {};

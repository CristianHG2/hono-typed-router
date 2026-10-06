import type { MiddlewareHandler } from 'hono';

/** @internal */
export declare const READS: unique symbol;

/**
 * Do not replace this key with `Omit<Variables, keyof reads>`. With `Omit`, each context in a
 * chain of `ContextEnv` middlewares contains the `Omit` of the previous context, and the check
 * time grows exponentially with the chain length.
 *
 * @internal
 */
export declare const SETS: unique symbol;

type IsAny<T> = 0 extends 1 & T ? true : false;

type HandlerEnv<THandler> = THandler extends MiddlewareHandler<infer E, any, any> ? E : never;

type EnvVars<E> =
  IsAny<E> extends true
    ? {}
    : E extends { Variables: infer V extends object }
      ? IsAny<V> extends true
        ? {}
        : V
      : {};

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

type EnvSets<E> =
  IsAny<E> extends true
    ? {}
    : E extends { readonly [SETS]: infer N extends object }
      ? N
      : EnvVars<E>;

/** @internal */
export type HandlerVars<THandler> = EnvVars<HandlerEnv<THandler>>;

/** @internal */
export type HandlerReads<THandler> = EnvReads<HandlerEnv<THandler>>;

/** @internal */
export type HandlerSets<THandler> = EnvSets<HandlerEnv<THandler>>;

/** @internal */
export type HandlerBindings<THandler> = EnvBindings<HandlerEnv<THandler>>;

/** @internal */
export type RedeclareMessage<K extends string> = K extends unknown
  ? `Cannot redeclare existing var: ${K}. Use another var name, or read ${K} from the context.`
  : never;

type CheckEnvFits<E, TVars> = [Exclude<keyof EnvReads<E>, keyof TVars>] extends [never]
  ? [Extract<keyof EnvSets<E>, keyof TVars>] extends [never]
    ? unknown
    : RedeclareMessage<Extract<keyof EnvSets<E>, keyof TVars> & string>
  : `This middleware reads vars that the context does not have: ${Exclude<keyof EnvReads<E>, keyof TVars> & string}`;

/** @internal */
export type CheckMiddlewareFits<THandler, TVars> = CheckEnvFits<HandlerEnv<THandler>, TVars>;

/** @internal */
export type RouterEnv<V extends object, B extends object> = [keyof B] extends [never]
  ? { Variables: V }
  : { Bindings: B; Variables: V };

/** @internal */
export type ContextBindings<TContext> = TContext extends { bindings: infer B extends object }
  ? B
  : {};

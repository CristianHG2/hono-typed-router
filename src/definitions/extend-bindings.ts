import type { MiddlewareHandler } from 'hono';
import type { CheckMiddlewareFits, HandlerBindings } from './env';
import type { FoldBindings } from './root-array';

// An extended context does not carry bindings. These checks make bindings on it a compile
// error, so that they are not lost without an error.

/**
 * The error of an extended `defineChildContext` with a parent that has bindings.
 *
 * @internal Exported for declaration emit.
 */
export type NoBindingsMessage =
  'Extended contexts do not carry Bindings: use defineChildContext from hono-typed-router for a child of a context with bindings';

/**
 * The error of an extended `.middleware()` or `defineRootContext` with a middleware that
 * declares `Bindings`.
 *
 * @internal Exported for declaration emit.
 */
export type NoMiddlewareBindingsMessage =
  'Extended contexts do not carry Bindings: use the contexts of hono-typed-router for a middleware with Bindings';

/**
 * `'none'` when `{}` is assignable to the bindings `B`, else `'some'`. Bindings with only
 * optional keys give `'none'`. The wildcard type that replaces a type parameter also gives
 * `'none'` (see `BindLoadedKind` in `bind.ts`). Thus each check puts its error in the true
 * branch of `extends 'some'`. A generic helper then compiles, and the check runs at its call.
 */
type BindingsKind<B> = [{}] extends [B] ? 'none' : 'some';

/**
 * The constraint of the bindings of a value-form parent: `object` for no bindings, else
 * {@link NoBindingsMessage}.
 *
 * @internal Exported for declaration emit.
 */
export type BindingsSlot<B> = BindingsKind<B> extends 'some' ? NoBindingsMessage : object;

/**
 * The check of a curried-form parent: `unknown` for no bindings, else an object whose
 * `bindings` is {@link NoBindingsMessage}.
 *
 * @internal Exported for declaration emit.
 */
export type CheckNoBindings<B> =
  BindingsKind<B> extends 'some' ? { bindings: NoBindingsMessage } : unknown;

/**
 * The check of a reusable middleware on an extended context: {@link NoMiddlewareBindingsMessage}
 * when the middleware declares `Bindings`, else `CheckMiddlewareFits`.
 *
 * @internal Exported for declaration emit.
 */
export type CheckExtendedMiddlewareFits<THandler, TVars> =
  BindingsKind<HandlerBindings<THandler>> extends 'some'
    ? NoMiddlewareBindingsMessage
    : CheckMiddlewareFits<THandler, TVars>;

/**
 * The check of the root array of an extended `defineRootContext`:
 * {@link NoMiddlewareBindingsMessage} when a middleware declares `Bindings`, else `unknown`.
 *
 * @internal Exported for declaration emit.
 */
export type CheckNoRootBindings<TMws extends readonly MiddlewareHandler[]> =
  BindingsKind<FoldBindings<TMws>> extends 'some' ? NoMiddlewareBindingsMessage : unknown;

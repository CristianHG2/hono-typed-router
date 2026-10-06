import type { MiddlewareHandler } from 'hono';
import type { CheckMiddlewareFits, HandlerBindings } from './env';
import type { FoldBindings } from './root-array';

/** @internal */
export type NoBindingsMessage =
  'Extended contexts do not carry Bindings: use defineChildContext from hono-typed-router for a child of a context with bindings';

/** @internal */
export type NoMiddlewareBindingsMessage =
  'Extended contexts do not carry Bindings: use the contexts of hono-typed-router for a middleware with Bindings';

/**
 * The wildcard type that replaces a type parameter gives `'none'` (see `BindLoadedKind`). Thus
 * each check puts its error in the true branch of `extends 'some'`, and a generic helper
 * compiles.
 */
type BindingsKind<B> = [{}] extends [B] ? 'none' : 'some';

/** @internal */
export type BindingsSlot<B> = BindingsKind<B> extends 'some' ? NoBindingsMessage : object;

/** @internal */
export type CheckNoBindings<B> =
  BindingsKind<B> extends 'some' ? { bindings: NoBindingsMessage } : unknown;

/** @internal */
export type CheckExtendedMiddlewareFits<THandler, TVars> =
  BindingsKind<HandlerBindings<THandler>> extends 'some'
    ? NoMiddlewareBindingsMessage
    : CheckMiddlewareFits<THandler, TVars>;

/** @internal */
export type CheckNoRootBindings<TMws extends readonly MiddlewareHandler[]> =
  BindingsKind<FoldBindings<TMws>> extends 'some' ? NoMiddlewareBindingsMessage : unknown;

import type { MiddlewareHandler } from 'hono';
import type { CheckMiddlewareFits, HandlerBindings } from './env';
import type { FoldBindings } from './root-array';

// The checks that make Cloudflare `Bindings` on an extended context a compile error. An
// extended context does not carry bindings, so a parent with bindings, or a middleware that
// declares `Bindings`, would otherwise lose them with no error.

/**
 * The error of an extended `defineChildContext` with a parent that has bindings.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type NoBindingsMessage =
  'Extended contexts do not carry Bindings: use defineChildContext from hono-typed-router for a child of a context with bindings';

/**
 * The error of an extended `.middleware()` or `defineRootContext` with a middleware that
 * declares `Bindings`.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type NoMiddlewareBindingsMessage =
  'Extended contexts do not carry Bindings: use the contexts of hono-typed-router for a middleware with Bindings';

/**
 * `'none'` when `{}` is assignable to the bindings `B`, else `'some'`. `{}`, `object`, `any`,
 * and bindings with only optional keys (or `Record<string, unknown>`) give `'none'`. When
 * TypeScript decides which branch of a deferred conditional type an argument must satisfy, it
 * puts a permissive wildcard type in place of a type parameter. The wildcard gives `'none'`.
 * Thus each check puts its error in the TRUE branch of `extends 'some'`: the wildcard skips
 * the error, and a generic helper over a parent with a bindings type parameter compiles. The
 * check then runs where the helper is called.
 */
type BindingsKind<B> = [{}] extends [B] ? 'none' : 'some';

/**
 * The constraint of the bindings of a value-form parent: `object` for no bindings, else
 * {@link NoBindingsMessage}.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type BindingsSlot<B> = BindingsKind<B> extends 'some' ? NoBindingsMessage : object;

/**
 * The check of a curried-form parent: `unknown` for no bindings, else an object whose
 * `bindings` is {@link NoBindingsMessage}.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type CheckNoBindings<B> =
  BindingsKind<B> extends 'some' ? { bindings: NoBindingsMessage } : unknown;

/**
 * The check of a reusable middleware on an extended context: {@link NoMiddlewareBindingsMessage}
 * when the middleware declares `Bindings`, else `CheckMiddlewareFits`.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type CheckExtendedMiddlewareFits<THandler, TVars> =
  BindingsKind<HandlerBindings<THandler>> extends 'some'
    ? NoMiddlewareBindingsMessage
    : CheckMiddlewareFits<THandler, TVars>;

/**
 * The check of the root array of an extended `defineRootContext`:
 * {@link NoMiddlewareBindingsMessage} when a middleware declares `Bindings`, else `unknown`.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type CheckNoRootBindings<TMws extends readonly MiddlewareHandler[]> =
  BindingsKind<FoldBindings<TMws>> extends 'some' ? NoMiddlewareBindingsMessage : unknown;

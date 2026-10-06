import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

function wrapsRestOfBody(node: ESTree.IfStatement): boolean {
  if (node.alternate !== null) {
    return false;
  }

  if (node.consequent.type !== 'BlockStatement' || node.consequent.body.length < 2) {
    return false;
  }

  const parent = node.parent;

  return parent.type === 'BlockStatement' && parent.body.at(-1) === node;
}

/** Flag a final `if` that wraps the rest of a function or loop body; prefer an early exit. */
export const preferEarlyReturnRule = defineRule({
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require an early `return` or `continue` instead of a final `if` that wraps the rest of a function or loop body.',
    },
    messages: {
      function:
        'Invert this condition and `return` early instead of wrapping the rest of the function in an `if`.',
      loop: 'Invert this condition and `continue` instead of wrapping the rest of the loop body in an `if`.',
    },
  },
  createOnce(context) {
    return {
      IfStatement(node) {
        if (!wrapsRestOfBody(node)) {
          return;
        }

        const owner = node.parent.parent;

        if (owner === null || owner === undefined) {
          return;
        }

        if (FUNCTION_TYPES.has(owner.type)) {
          context.report({ node, messageId: 'function' });

          return;
        }

        if (LOOP_TYPES.has(owner.type)) {
          context.report({ node, messageId: 'loop' });
        }
      },
    };
  },
});

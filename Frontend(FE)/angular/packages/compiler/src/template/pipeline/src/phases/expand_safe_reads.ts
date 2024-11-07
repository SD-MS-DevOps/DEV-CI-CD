/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as o from '../../../../output/output_ast';
import * as ir from '../../ir';
import {CompilationJob} from '../compilation';

interface SafeTransformContext {
  job: CompilationJob;
}

/**
 * Safe read expressions such as `a?.b` have different semantics in Angular templates as
 * compared to JavaScript. In particular, they default to `null` instead of `undefined`. This phase
 * finds all unresolved safe read expressions, and converts them into the appropriate output AST
 * reads, guarded by null checks. We generate temporaries as needed, to avoid re-evaluating the same
 * sub-expression multiple times.
 */
export function expandSafeReads(job: CompilationJob): void {
  for (const unit of job.units) {
    for (const op of unit.ops()) {
      ir.transformExpressionsInOp(op, (e) => safeTransform(e, {job}), ir.VisitorContextFlag.None);
      ir.transformExpressionsInOp(op, ternaryTransform, ir.VisitorContextFlag.None);
    }
  }
}

// A lookup set of all the expression kinds that require a temporary variable to be generated.
const requiresTemporary = [
  o.InvokeFunctionExpr,
  o.LiteralArrayExpr,
  o.LiteralMapExpr,
  ir.SafeInvokeFunctionExpr,
  ir.PipeBindingExpr,
].map((e) => e.constructor.name);

function needsTemporaryInSafeAccess(e: o.Expression): boolean {
  // TODO: We probably want to use an expression visitor to recursively visit all descendents.
  // However, that would potentially do a lot of extra work (because it cannot short circuit), so we
  // implement the logic ourselves for now.
  if (e instanceof o.UnaryOperatorExpr) {
    return needsTemporaryInSafeAccess(e.expr);
  } else if (e instanceof o.BinaryOperatorExpr) {
    return needsTemporaryInSafeAccess(e.lhs) || needsTemporaryInSafeAccess(e.rhs);
  } else if (e instanceof o.ConditionalExpr) {
    if (e.falseCase && needsTemporaryInSafeAccess(e.falseCase)) return true;
    return needsTemporaryInSafeAccess(e.condition) || needsTemporaryInSafeAccess(e.trueCase);
  } else if (e instanceof o.NotExpr) {
    return needsTemporaryInSafeAccess(e.condition);
  } else if (e instanceof ir.AssignTemporaryExpr) {
    return needsTemporaryInSafeAccess(e.expr);
  } else if (e instanceof o.ReadPropExpr) {
    return needsTemporaryInSafeAccess(e.receiver);
  } else if (e instanceof o.ReadKeyExpr) {
    return needsTemporaryInSafeAccess(e.receiver) || needsTemporaryInSafeAccess(e.index);
  }
  // TODO: Switch to a method which is exhaustive of newly added expression subtypes.
  return (
    e instanceof o.InvokeFunctionExpr ||
    e instanceof o.LiteralArrayExpr ||
    e instanceof o.LiteralMapExpr ||
    e instanceof ir.SafeInvokeFunctionExpr ||
    e instanceof ir.PipeBindingExpr
  );
}

function temporariesIn(e: o.Expression): Set<ir.XrefId> {
  const temporaries = new Set<ir.XrefId>();
  // TODO: Although it's not currently supported by the transform helper, we should be able to
  // short-circuit exploring the tree to do less work. In particular, we don't have to penetrate
  // into the subexpressions of temporary assignments.
  ir.transformExpressionsInExpression(
    e,
    (e) => {
      if (e instanceof ir.AssignTemporaryExpr) {
        temporaries.add(e.xref);
      }
      return e;
    },
    ir.VisitorContextFlag.None,
  );
  return temporaries;
}

function eliminateTemporaryAssignments(
  e: o.Expression,
  tmps: Set<ir.XrefId>,
  ctx: SafeTransformContext,
): o.Expression {
  // TODO: We can be more efficient than the transform helper here. We don't need to visit any
  // descendents of temporary assignments.
  ir.transformExpressionsInExpression(
    e,
    (e) => {
      if (e instanceof ir.AssignTemporaryExpr && tmps.has(e.xref)) {
        const read = new ir.ReadTemporaryExpr(e.xref);
        // `TemplateDefinitionBuilder` has the (accidental?) behavior of generating assignments of
        // temporary variables to themselves. This happens because some subexpression that the
        // temporary refers to, possibly through nested temporaries, has a function call. We copy that
        // behavior here.
        return ctx.job.compatibility === ir.CompatibilityMode.TemplateDefinitionBuilder
          ? new ir.AssignTemporaryExpr(read, read.xref)
          : read;
      }
      return e;
    },
    ir.VisitorContextFlag.None,
  );
  return e;
}

/**
 * Creates a safe ternary guarded by the input expression, and with a body generated by the provided
 * callback on the input expression. Generates a temporary variable assignment if needed, and
 * deduplicates nested temporary assignments if needed.
 */
function safeTernaryWithTemporary(
  guard: o.Expression,
  body: (e: o.Expression) => o.Expression,
  ctx: SafeTransformContext,
): ir.SafeTernaryExpr {
  let result: [o.Expression, o.Expression];
  if (needsTemporaryInSafeAccess(guard)) {
    const xref = ctx.job.allocateXrefId();
    result = [new ir.AssignTemporaryExpr(guard, xref), new ir.ReadTemporaryExpr(xref)];
  } else {
    result = [guard, guard.clone()];
    // Consider an expression like `a?.[b?.c()]?.d`. The `b?.c()` will be transformed first,
    // introducing a temporary assignment into the key. Then, as part of expanding the `?.d`. That
    // assignment will be duplicated into both the guard and expression sides. We de-duplicate it,
    // by transforming it from an assignment into a read on the expression side.
    eliminateTemporaryAssignments(result[1], temporariesIn(result[0]), ctx);
  }
  return new ir.SafeTernaryExpr(result[0], body(result[1]));
}

function isSafeAccessExpression(
  e: o.Expression,
): e is ir.SafePropertyReadExpr | ir.SafeKeyedReadExpr | ir.SafeInvokeFunctionExpr {
  return (
    e instanceof ir.SafePropertyReadExpr ||
    e instanceof ir.SafeKeyedReadExpr ||
    e instanceof ir.SafeInvokeFunctionExpr
  );
}

function isUnsafeAccessExpression(
  e: o.Expression,
): e is o.ReadPropExpr | o.ReadKeyExpr | o.InvokeFunctionExpr {
  return (
    e instanceof o.ReadPropExpr || e instanceof o.ReadKeyExpr || e instanceof o.InvokeFunctionExpr
  );
}

function isAccessExpression(
  e: o.Expression,
): e is
  | o.ReadPropExpr
  | ir.SafePropertyReadExpr
  | o.ReadKeyExpr
  | ir.SafeKeyedReadExpr
  | o.InvokeFunctionExpr
  | ir.SafeInvokeFunctionExpr {
  return isSafeAccessExpression(e) || isUnsafeAccessExpression(e);
}

function deepestSafeTernary(e: o.Expression): ir.SafeTernaryExpr | null {
  if (isAccessExpression(e) && e.receiver instanceof ir.SafeTernaryExpr) {
    let st = e.receiver;
    while (st.expr instanceof ir.SafeTernaryExpr) {
      st = st.expr;
    }
    return st;
  }
  return null;
}

// TODO: When strict compatibility with TemplateDefinitionBuilder is not required, we can use `&&`
// instead to save some code size.
function safeTransform(e: o.Expression, ctx: SafeTransformContext): o.Expression {
  if (!isAccessExpression(e)) {
    return e;
  }

  const dst = deepestSafeTernary(e);

  if (dst) {
    if (e instanceof o.InvokeFunctionExpr) {
      dst.expr = dst.expr.callFn(e.args);
      return e.receiver;
    }
    if (e instanceof o.ReadPropExpr) {
      dst.expr = dst.expr.prop(e.name);
      return e.receiver;
    }
    if (e instanceof o.ReadKeyExpr) {
      dst.expr = dst.expr.key(e.index);
      return e.receiver;
    }
    if (e instanceof ir.SafeInvokeFunctionExpr) {
      dst.expr = safeTernaryWithTemporary(dst.expr, (r: o.Expression) => r.callFn(e.args), ctx);
      return e.receiver;
    }
    if (e instanceof ir.SafePropertyReadExpr) {
      dst.expr = safeTernaryWithTemporary(dst.expr, (r: o.Expression) => r.prop(e.name), ctx);
      return e.receiver;
    }
    if (e instanceof ir.SafeKeyedReadExpr) {
      dst.expr = safeTernaryWithTemporary(dst.expr, (r: o.Expression) => r.key(e.index), ctx);
      return e.receiver;
    }
  } else {
    if (e instanceof ir.SafeInvokeFunctionExpr) {
      return safeTernaryWithTemporary(e.receiver, (r: o.Expression) => r.callFn(e.args), ctx);
    }
    if (e instanceof ir.SafePropertyReadExpr) {
      return safeTernaryWithTemporary(e.receiver, (r: o.Expression) => r.prop(e.name), ctx);
    }
    if (e instanceof ir.SafeKeyedReadExpr) {
      return safeTernaryWithTemporary(e.receiver, (r: o.Expression) => r.key(e.index), ctx);
    }
  }

  return e;
}

function ternaryTransform(e: o.Expression): o.Expression {
  if (!(e instanceof ir.SafeTernaryExpr)) {
    return e;
  }
  return new o.ConditionalExpr(
    new o.BinaryOperatorExpr(o.BinaryOperator.Equals, e.guard, o.NULL_EXPR),
    o.NULL_EXPR,
    e.expr,
  );
}

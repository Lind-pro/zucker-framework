import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface TransactionBoundaryPolicy {
  rootClientNames: readonly string[];
  transactionClientRequiredPattern: RegExp;
  externalCallPattern: RegExp;
}

export interface TransactionBoundaryViolation {
  file: string;
  line: number;
  message: string;
}

/** Inspect interactive Prisma transaction callbacks using consumer-defined service/call patterns. */
export function findTransactionBoundaryViolations(
  source: string,
  fileName: string,
  policy: TransactionBoundaryPolicy,
): TransactionBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: TransactionBoundaryViolation[] = [];
  const addViolation = (node: ts.Node, message: string) => {
    violations.push({
      file: fileName,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      message,
    });
  };
  const inspectTransaction = (callback: ts.ArrowFunction | ts.FunctionExpression) => {
    const transactionClient = callback.parameters[0]?.name.getText(sourceFile);
    if (!transactionClient) return;
    const inspectBody = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sourceFile);
        if (
          policy.rootClientNames.some(
            (name) => callee.startsWith(`${name}.`) && transactionClient !== name,
          )
        ) {
          addViolation(node, 'interactive transaction uses the root Prisma client');
        }
        if (callee === 'Promise.all' || callee === 'Promise.allSettled') {
          addViolation(node, 'interactive transaction runs parallel work');
        }
        if (policy.externalCallPattern.test(callee)) {
          addViolation(node, `interactive transaction performs external work via ${callee}`);
        }
        if (
          policy.transactionClientRequiredPattern.test(callee) &&
          !node.arguments.some((argument) => argument.getText(sourceFile) === transactionClient)
        ) {
          addViolation(node, `service call ${callee} does not receive the transaction client`);
        }
      }
      ts.forEachChild(node, inspectBody);
    };
    inspectBody(callback.body);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile).endsWith('.$transaction')
    ) {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))
        inspectTransaction(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function checkTransactionBoundaries(
  rootDirectory: string,
  policy: TransactionBoundaryPolicy,
): TransactionBoundaryViolation[] {
  const scan = (directory: string): TransactionBoundaryViolation[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return scan(entryPath);
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) return [];
      return findTransactionBoundaryViolations(readFileSync(entryPath, 'utf8'), entryPath, policy);
    });
  return scan(rootDirectory);
}

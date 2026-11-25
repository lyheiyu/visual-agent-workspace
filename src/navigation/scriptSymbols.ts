import * as ts from 'typescript';
import type { FunctionRange, LineRange } from './symbolSearch';

interface ScriptSymbol extends Omit<FunctionRange, 'name'> {
  name?: string;
}

export function parseScriptSymbols(filePath: string, text: string) {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filePath)) return undefined;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const line = (offset: number) => source.getLineAndCharacterOfPosition(offset).line;
  const range = (node: ts.Node): LineRange => ({ startLine: line(node.getStart(source)), endLine: line(node.end - 1) });
  const functions: ScriptSymbol[] = [];
  const definitions: Array<{ name: string; range: LineRange }> = [];
  function visit(node: ts.Node): void {
    if (ts.isClassLike(node)) {
      functions.push({ ...range(node), kind: 'class', name: node.name?.text });
    } else if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const parent = node.parent;
      const binding = ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ? parent : undefined;
      const method = ts.isMethodDeclaration(node) || ts.isAccessor(node) || ts.isConstructorDeclaration(node);
      const name = binding?.name ?? node.name;
      functions.push({
        ...range(binding ?? node),
        kind: method ? 'method' : 'function',
        name: ts.isConstructorDeclaration(node) ? 'constructor' : name && ts.isIdentifier(name) ? name.text : undefined,
      });
    }
    ts.forEachChild(node, visit);
  }
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) definitions.push({ name: declaration.name.text, range: range(statement) });
      }
    }
    visit(statement);
  }
  return { functions, definitions };
}

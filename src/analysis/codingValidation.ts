import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInside } from '../navigation/pathSafety';

/** Local syntax and interface checks. These do not establish runtime correctness. */
export function inspectScript(filePath: string, text: string): { syntax: string[]; exports: string[]; imports: string[] } {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const exports = new Set<string>();
  const imports = new Set<string>();
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const syntax = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  const bindings = new Map<string, boolean>();
  const bind = (name: string, lexical: boolean) => {
    if (bindings.has(name) && (bindings.get(name) || lexical)) syntax.push('Duplicate top-level binding: ' + name);
    bindings.set(name, lexical || (bindings.get(name) ?? false));
  };
  const bindName = (name: ts.BindingName, lexical: boolean): void => {
    if (ts.isIdentifier(name)) bind(name.text, lexical);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindName(element.name, lexical);
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindName(declaration.name, !!(statement.declarationList.flags & ts.NodeFlags.BlockScoped));
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) bind(statement.name.text, false);
    else if (ts.isClassDeclaration(statement) && statement.name) bind(statement.name.text, true);
    else if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      if (statement.importClause.name) bind(statement.importClause.name.text, true);
      const named = statement.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) if (!element.isTypeOnly) bind(element.name.text, true);
      }
      else if (named && ts.isNamespaceImport(named)) bind(named.name.text, true);
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left.getText(source);
      if (target === 'module.exports') {
        exports.add('module.exports');
        if (ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) if (property.name) exports.add(property.name.getText(source));
        }
      } else if (/^(module\.)?exports\.[\w$]+$/.test(target)) exports.add(target.split('.').pop()!);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) exports.add(element.name.text);
    }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) exports.add('default');
      if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) exports.add((node.name as ts.Identifier).text);
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) exports.add(declaration.name.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { syntax, exports: [...exports].sort(), imports: [...imports].sort() };
}

export function scriptChangeRisks(file: string, before: string, after: string): string[] {
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return [];
  const old = inspectScript(file, before);
  const next = inspectScript(file, after);
  return [
    ...next.syntax.filter((message) => !old.syntax.includes(message)).map((message) => 'New syntax error: ' + message),
    ...old.exports.filter((name) => !next.exports.includes(name)).map((name) => 'Removed public export: ' + name),
    ...next.imports.filter((name) => !old.imports.includes(name)).map((name) => 'New dependency to verify: ' + name),
  ];
}

/** Check common require/export shape mistakes against small, local dependencies. */
export function localDependencyIssues(root: string, file: string, text: string, before = text): string[] {
  if (!/\.[cm]?[jt]s$/i.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const previous = ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true);
  const functions = new Set(previous.statements.filter(ts.isFunctionDeclaration).map((declaration) => declaration.name?.text));
  const issues: string[] = [];
  let checked = 0;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(source) === 'require' && node.initializer.arguments.length === 1 &&
        ts.isStringLiteral(node.initializer.arguments[0]) && checked++ < 20) {
      const moduleName = node.initializer.arguments[0].text;
      if (moduleName.startsWith('.')) {
        const base = path.resolve(path.dirname(path.resolve(root, file)), moduleName);
        const target = [base, base + '.js', base + '.cjs', path.join(base, 'index.js')].find((candidate) =>
          isInside(root, candidate) && /\.[cm]?js$/i.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (target && isInside(fs.realpathSync(root), fs.realpathSync(target)) && fs.statSync(target).size < 100000) {
          const dependency = ts.createSourceFile(target, fs.readFileSync(target, 'utf8'), ts.ScriptTarget.Latest, true);
          for (const statement of dependency.statements) {
            if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
            const assignment = statement.expression;
            if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || assignment.left.getText(dependency) !== 'module.exports') continue;
            if (ts.isObjectLiteralExpression(assignment.right) && ts.isIdentifier(node.name) && functions.has(node.name.text) &&
                assignment.right.properties.some((property) => property.name?.getText(dependency) === node.name.getText(source))) {
              issues.push(`require("${moduleName}") returns an object containing "${node.name.text}". Preserve the function interface with destructuring or .${node.name.text}, instead of exporting the object as that function.`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  try { visit(source); }
  catch (error) { issues.push('Dependency inspection could not finish: ' + String(error)); }
  return issues;
}

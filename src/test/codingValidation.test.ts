import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptChangeRisks, localDependencyIssues } from '../analysis/codingValidation';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('targeted CommonJS fixes preserve the interface while dropped exports and broken syntax are identified', () => {
  const original = 'function add(a,b) { return a+b; } function divide(a,b) { return a/b; } module.exports = { add, divide };';
  assert.deepEqual(scriptChangeRisks('math.js', original, original.replace('return a/b;', 'if (!b) throw Error("zero"); return a/b;')), []);
  assert.ok(scriptChangeRisks('math.js', original, 'export function divide(a,b) { return a/b; }').includes('Removed public export: module.exports'));
  assert.ok(scriptChangeRisks('math.js', original, 'function divide( {').some((risk) => risk.startsWith('New syntax error:')));
  assert.ok(scriptChangeRisks('math.js', original, original + '\nconst divide = require("./divide");').some((risk) => risk.includes('Duplicate top-level binding: divide')));
  assert.ok(scriptChangeRisks('math.js', original, original + '\nconst { divide } = require("./divide");').some((risk) => risk.includes('Duplicate top-level binding: divide')));
});

test('dependency additions are exposed for validation', () => {
  assert.deepEqual(scriptChangeRisks('math.js', 'module.exports = {};', 'const value = require("./divide"); module.exports = {};'), ['New dependency to verify: ./divide']);
});

test('CommonJS extraction identifies an object required in place of an existing public function', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-dependency-check-'));
  const dependency = path.join(root, 'divide.js');
  fs.writeFileSync(dependency, 'function divide(a,b){return a/b;} module.exports = { divide };');
  try {
    const before = 'function divide(a,b){return a/b;} module.exports = { divide };';
    const incorrect = 'const divide = require("./divide"); module.exports = { divide };';
    assert.match(localDependencyIssues(root, path.join(root, 'math.js'), incorrect, before)[0], /returns an object/);
    assert.deepEqual(localDependencyIssues(root, path.join(root, 'math.js'), 'const {divide} = require("./divide"); module.exports = { divide };', before), []);
  } finally {
    fs.unlinkSync(dependency);
    fs.rmdirSync(root);
  }
});

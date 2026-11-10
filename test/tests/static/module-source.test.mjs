import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { stripModuleSyntax } from '../../../tools/lib/module-source.mjs';
import { parse } from 'acorn';

test('bundle transformation preserves executable statements after same-line imports', () => {
  const source = "import crypto from 'node:crypto'; export const answer = 42;";
  const transformed = stripModuleSyntax(source);
  assert.equal(vm.runInNewContext(transformed + '\nanswer'), 42);
});
test('bundle transformation supports multiline named imports and exports', () => {
  const source = "import {\n a,\n b\n} from './dependency.js';\nexport function sum() { return a+b; }";
  assert.equal(vm.runInNewContext(stripModuleSyntax(source) + '\nsum()', {a:3,b:4}), 7);
});
test('bundle transformation never removes import-like text inside a template', () => {
  const source = 'export const message = `\nimport something;\nexport function sample() {}\n`;';
  assert.equal(vm.runInNewContext(stripModuleSyntax(source)+'\nmessage'), '\nimport something;\nexport function sample() {}\n');
});
test('re-exports are removed without removing the adjacent implementation', () => {
  assert.equal(vm.runInNewContext(stripModuleSyntax("export { item } from './other.js'; const answer=6;")+'\nanswer'), 6);
});
test('unsupported defaults and wildcard exports fail closed', () => {
  for (const source of ['export default 3;', "export * from './x.js';"]) assert.throws(()=>stripModuleSyntax(source), /unsupported/);
});
test('aliased module bindings cannot be silently flattened incorrectly', () => {
  assert.throws(()=>stripModuleSyntax("import { original as alias } from './x.js';"), /aliased/);
});

test('current UI and ORCE bundles have no module syntax left in generated functions', () => {
  const flow=JSON.parse(fs.readFileSync('dist/fap-pci-flow.json','utf8'));
  for(const node of flow.filter(n=>n.type==='function'))
    assert.doesNotThrow(()=>parse(node.func,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true}),node.name);
});

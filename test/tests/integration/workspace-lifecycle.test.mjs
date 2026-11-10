import test from 'node:test';
import assert from 'node:assert/strict';
import { createPciOperationRunner } from '../../../src/issuer/operation-runner.js';

test('the operation runner preserves the original error when input recovery fails', async () => {
  const state = { busy: { value: false }, notice: { value: '' }, error: { value: null } };
  const run = createPciOperationRunner(state, error => ({ message: error.message }), async () => { throw Error('recovery failure'); });
  await run(async () => { throw Object.assign(Error('original failure'), { code: 'PCI-SR2-INPUT-LOST' }); });
  assert.equal(state.error.value.message, 'original failure'); assert.equal(state.busy.value, false);
});

test('nested operations leave progress active until their parent completes', async () => {
  const state = { busy: { value: false }, notice: { value: '' }, error: { value: null } };
  const run = createPciOperationRunner(state, error => error, async () => {});
  await run(async () => { await run(async () => {}); assert.equal(state.busy.value, true); });
  assert.equal(state.error.value, null, 'the assertion inside the parent operation must not have been caught by the runner');
  assert.equal(state.busy.value, false);
});

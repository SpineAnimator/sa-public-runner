import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

test('Node.js executes on Linux', () => {
  assert.equal(process.platform, 'linux');
});

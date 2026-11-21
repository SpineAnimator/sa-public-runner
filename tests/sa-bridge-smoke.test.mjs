import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('SA bridge task manifest is present', () => {
  const task = JSON.parse(fs.readFileSync(new URL('../task.json', import.meta.url), 'utf8'));
  assert.equal(task.task_id, 'sa-core-bridge');
  assert.ok(task.required_stages.includes('official-runtime'));
});

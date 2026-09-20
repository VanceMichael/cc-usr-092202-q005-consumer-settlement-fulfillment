import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRecords } from '../src/records.js';

test('公开样例结构完整', async () => {
  const raw = await readFile(new URL('../fixtures/context.json', import.meta.url), 'utf8');
  const value = parseRecords(raw);
  assert.equal(value.domain, 'consumer-settlement-fulfillment');
  assert.ok(value.records.length >= 2);
});

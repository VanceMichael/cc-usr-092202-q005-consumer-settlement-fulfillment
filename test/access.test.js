import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgreement, signAgreement } from '../src/agreement.js';
import { viewAgreement } from '../src/access.js';

function makeAgreement() {
  const agreement = createAgreement({
    id: 'SA-1',
    consumer: { id: 'C-1', realName: '王某', phone: '13800000000', idNumber: '110101199001011234', address: '某小区 1 号楼' },
    merchant: { id: 'M-1', realName: '李某', phone: '13900000000' },
    handlerId: 'H-1',
    terms: [
      { id: 'OB-T', kind: 'return', obligor: 'consumer', deadline: '2026-10-05T00:00:00Z', shipFrom: '某小区 1 号楼', shipTo: '商家仓库' },
    ],
  });
  signAgreement(agreement, 'consumer');
  signAgreement(agreement, 'merchant');
  return agreement;
}

test('当前经办人可以看到敏感身份与收发地址', () => {
  const view = viewAgreement(makeAgreement(), 'H-1');
  assert.equal(view.consumer.phone, '13800000000');
  assert.equal(view.consumer.idNumber, '110101199001011234');
  assert.equal(view.obligations[0].addresses.from, '某小区 1 号楼');
});

test('非经办人只能看到脱敏视图', () => {
  const agreement = makeAgreement();
  const view = viewAgreement(agreement, 'H-2');
  assert.equal(view.consumer.realName, '***');
  assert.equal(view.consumer.phone, '***');
  assert.equal(view.consumer.idNumber, '***');
  assert.equal(view.consumer.address, '***');
  assert.equal(view.merchant.phone, '***');
  assert.equal(view.obligations[0].addresses.from, '***');
  assert.equal(view.obligations[0].addresses.to, '***');
  // 非敏感字段不受影响。
  assert.equal(view.consumer.id, 'C-1');
  // 脱敏不改动原始协议。
  assert.equal(agreement.consumer.phone, '13800000000');
});

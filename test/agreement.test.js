import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObligation,
  createAgreement,
  signAgreement,
  proposeAmendment,
  consentAmendment,
} from '../src/agreement.js';

const baseTerms = [
  { kind: 'refund', obligor: 'merchant', deadline: '2026-10-01T00:00:00Z', amount: 200 },
  { kind: 'return', obligor: 'consumer', deadline: '2026-10-05T00:00:00Z', shipFrom: '消费者地址', shipTo: '商家仓库' },
];

test('义务拆分为责任方、期限、金额、地址与可接受证据', () => {
  const obligation = buildObligation(baseTerms[0], 0);
  assert.equal(obligation.id, 'OB-1');
  assert.equal(obligation.obligor, 'merchant');
  assert.equal(obligation.amount, 200);
  assert.deepEqual(obligation.acceptableEvidence, ['payment_callback']);
  const returnObligation = buildObligation(baseTerms[1], 1);
  assert.deepEqual(returnObligation.addresses, { from: '消费者地址', to: '商家仓库' });
});

test('义务缺少责任方、期限或退款金额时拒绝生成', () => {
  assert.throws(() => buildObligation({ kind: 'refund', deadline: '2026-10-01', amount: 1 }, 0), /责任方/);
  assert.throws(() => buildObligation({ kind: 'refund', obligor: 'merchant', amount: 1 }, 0), /期限/);
  assert.throws(() => buildObligation({ kind: 'refund', obligor: 'merchant', deadline: '2026-10-01' }, 0), /金额/);
  assert.throws(() => buildObligation({ kind: 'coupon', obligor: 'merchant', deadline: '2026-10-01' }, 0), /未知义务类型/);
});

function signedAgreement() {
  const agreement = createAgreement({
    id: 'SA-1',
    consumer: { id: 'C-1' },
    merchant: { id: 'M-1' },
    handlerId: 'H-1',
    terms: baseTerms,
  });
  signAgreement(agreement, 'consumer', '2026-09-20T10:00:00Z');
  assert.equal(agreement.status, 'draft');
  signAgreement(agreement, 'merchant', '2026-09-20T11:00:00Z');
  assert.equal(agreement.status, 'signed');
  return agreement;
}

test('双方签署后协议生效', () => {
  const agreement = signedAgreement();
  assert.equal(agreement.version, 1);
  assert.ok(agreement.signatures.consumer);
  assert.ok(agreement.signatures.merchant);
});

test('任何一方都不能单独改写已签协议', () => {
  const agreement = signedAgreement();
  const amendment = proposeAmendment(agreement, 'merchant', {
    updateObligations: [{ id: 'OB-1', patch: { amount: 50 } }],
  });
  // 提出方再次同意仍只有一方同意，协议不变。
  consentAmendment(agreement, amendment.id, 'merchant');
  assert.equal(amendment.status, 'pending');
  assert.equal(agreement.version, 1);
  assert.equal(agreement.obligations[0].amount, 200);
  // 另一方同意后修订生效。
  consentAmendment(agreement, amendment.id, 'consumer');
  assert.equal(amendment.status, 'applied');
  assert.equal(agreement.version, 2);
  assert.equal(agreement.obligations[0].amount, 50);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OBLIGATION_STATUS,
  createAgreement,
  applyEvent,
  sweepBreaches,
  amendTerms,
  agreementStatus,
  viewAgreement,
} from '../src/fulfillment.js';

function sampleInput() {
  return {
    id: 'ag-test',
    handler_id: 'mediator-1',
    parties: {
      consumer: { real_name: '张某', phone: '13800000000', id_number: '110101199001010011' },
      merchant: { real_name: '李某', phone: '13900000000' },
    },
    obligations: [
      {
        id: 'ob-return',
        type: 'return',
        responsible: 'consumer',
        deadline: '2026-09-05T00:00:00Z',
        addresses: { from: '消费者地址', to: '商家仓库' },
        evidence: ['logistics_signed'],
      },
      {
        id: 'ob-refund',
        type: 'refund',
        responsible: 'merchant',
        deadline: '2026-09-10T00:00:00Z',
        amount: 300,
        loss_id: 'loss-1',
        depends_on: 'ob-return',
        addresses: { from: '商家账户', to: '消费者账户' },
        evidence: ['payment_callback'],
      },
    ],
  };
}

function obligation(agreement, id) {
  return agreement.obligations.find((ob) => ob.id === id);
}

test('协议样例结构完整并生成履约跟踪实例', async () => {
  const raw = await readFile(new URL('../fixtures/agreement-sample.json', import.meta.url), 'utf8');
  const agreement = createAgreement(JSON.parse(raw));
  assert.equal(agreement.obligations.length, 4);
  assert.ok(agreement.obligations.every((ob) => ob.status === OBLIGATION_STATUS.PROMISED));
  assert.equal(agreementStatus(agreement), 'promised');
});

test('退款回调重放不会重复完成义务', () => {
  const agreement = createAgreement(sampleInput());
  applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'signed' });
  const event = { event_id: 'pay-1', type: 'payment_callback', obligation_id: 'ob-refund', amount: 300, loss_id: 'loss-1' };
  assert.deepEqual(applyEvent(agreement, event), { fulfilled: true });
  assert.deepEqual(applyEvent(agreement, event), { duplicate: true });
  assert.equal(obligation(agreement, 'ob-refund').remaining, 0);
  assert.equal(agreement.compensated_losses.filter((id) => id === 'loss-1').length, 1);
});

test('部分退款按真实顺序减少剩余责任', () => {
  const agreement = createAgreement(sampleInput());
  applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'signed' });
  const first = applyEvent(agreement, { event_id: 'pay-1', type: 'payment_callback', obligation_id: 'ob-refund', amount: 100 });
  assert.deepEqual(first, { partial: true, remaining: 200 });
  assert.equal(obligation(agreement, 'ob-refund').status, OBLIGATION_STATUS.IN_PROGRESS);
  const second = applyEvent(agreement, { event_id: 'pay-2', type: 'payment_callback', obligation_id: 'ob-refund', amount: 200, loss_id: 'loss-1' });
  assert.deepEqual(second, { fulfilled: true });
});

test('前置退货未了结时退款不到期', () => {
  const agreement = createAgreement(sampleInput());
  const result = applyEvent(agreement, { event_id: 'pay-1', type: 'payment_callback', obligation_id: 'ob-refund', amount: 300 });
  assert.equal(result.blocked, 'dependency_pending');
  assert.equal(obligation(agreement, 'ob-refund').status, OBLIGATION_STATUS.PROMISED);
});

test('拒收不解除义务，责任方需重新履行', () => {
  const agreement = createAgreement(sampleInput());
  const result = applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'rejected' });
  assert.deepEqual(result, { rejected: true });
  assert.equal(obligation(agreement, 'ob-return').status, OBLIGATION_STATUS.IN_PROGRESS);
});

test('退货丢失后不再要求重复退货并释放关联退款义务', () => {
  const agreement = createAgreement(sampleInput());
  const result = applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'lost' });
  assert.deepEqual(result, { lost: true });
  assert.equal(obligation(agreement, 'ob-return').status, OBLIGATION_STATUS.CANCELLED);
  assert.equal(obligation(agreement, 'ob-refund').depends_on, null);
  assert.equal(agreement.reviews.length, 1);
  const paid = applyEvent(agreement, { event_id: 'pay-1', type: 'payment_callback', obligation_id: 'ob-refund', amount: 300, loss_id: 'loss-1' });
  assert.deepEqual(paid, { fulfilled: true });
});

test('消费者撤销同意后剩余义务解除，已完成义务不回退', () => {
  const agreement = createAgreement(sampleInput());
  applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'signed' });
  applyEvent(agreement, { event_id: 'pay-1', type: 'payment_callback', obligation_id: 'ob-refund', amount: 300, loss_id: 'loss-1' });
  const input = sampleInput();
  input.obligations.push({
    id: 'ob-repair',
    type: 'repair',
    responsible: 'merchant',
    deadline: '2026-09-20T00:00:00Z',
    addresses: { from: '维修点', to: '消费者地址' },
    evidence: ['repair_report'],
  });
  const withRepair = createAgreement(input);
  applyEvent(withRepair, { event_id: 'rv-1', type: 'consumer_revoke' });
  assert.equal(obligation(withRepair, 'ob-repair').status, OBLIGATION_STATUS.CANCELLED);
  assert.equal(agreementStatus(withRepair), 'revoked');
  assert.equal(obligation(agreement, 'ob-refund').status, OBLIGATION_STATUS.FULFILLED);
});

test('商家停业时剩余义务按违约升级', () => {
  const agreement = createAgreement(sampleInput());
  const result = applyEvent(agreement, { event_id: 'mc-1', type: 'merchant_closed', at: '2026-09-03T00:00:00Z' });
  assert.equal(result.escalated, 2);
  assert.ok(agreement.obligations.every((ob) => ob.status === OBLIGATION_STATUS.BREACHED));
  assert.equal(agreement.escalations.length, 2);
  assert.equal(agreementStatus(agreement), 'breached');
});

test('消费者确认与客观凭证不一致时先进入人工复核', () => {
  const agreement = createAgreement(sampleInput());
  applyEvent(agreement, { event_id: 'cf-1', type: 'consumer_confirm', obligation_id: 'ob-return', received: false });
  const result = applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'signed' });
  assert.deepEqual(result, { review: true });
  assert.equal(obligation(agreement, 'ob-return').status, OBLIGATION_STATUS.IN_PROGRESS);
  const resolved = applyEvent(agreement, { event_id: 'mr-1', type: 'manual_review_resolve', review_id: 'review-1', outcome: 'confirm_fulfilled' });
  assert.deepEqual(resolved, { resolved: 'confirm_fulfilled' });
  assert.equal(obligation(agreement, 'ob-return').status, OBLIGATION_STATUS.FULFILLED);
});

test('客观凭证先到达后消费者异议同样拉回复核', () => {
  const agreement = createAgreement(sampleInput());
  applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'signed' });
  assert.equal(obligation(agreement, 'ob-return').status, OBLIGATION_STATUS.FULFILLED);
  const result = applyEvent(agreement, { event_id: 'cf-1', type: 'consumer_confirm', obligation_id: 'ob-return', received: false });
  assert.deepEqual(result, { review: true });
  assert.equal(obligation(agreement, 'ob-return').status, OBLIGATION_STATUS.IN_PROGRESS);
  applyEvent(agreement, { event_id: 'mr-1', type: 'manual_review_resolve', review_id: 'review-1', outcome: 'confirm_unfulfilled' });
  assert.equal(obligation(agreement, 'ob-return').status, OBLIGATION_STATUS.IN_PROGRESS);
});

test('同一损失不会因多个渠道再次获得赔偿', () => {
  const agreement = createAgreement(sampleInput());
  applyEvent(agreement, { event_id: 'lg-1', type: 'logistics_callback', obligation_id: 'ob-return', outcome: 'signed' });
  applyEvent(agreement, { event_id: 'pay-platform', type: 'payment_callback', obligation_id: 'ob-refund', amount: 300, loss_id: 'loss-1' });
  const replay = applyEvent(agreement, { event_id: 'pay-bank', type: 'payment_callback', obligation_id: 'ob-refund', amount: 300, loss_id: 'loss-1' });
  assert.deepEqual(replay, { blocked: 'loss_already_compensated' });
  assert.equal(agreement.blocked_events.length, 1);
});

test('任何一方都不能单独改写已签协议', () => {
  const agreement = createAgreement(sampleInput());
  assert.throws(
    () => amendTerms(agreement, [{ obligation_id: 'ob-refund', deadline: '2026-09-15T00:00:00Z' }], { consumer: true }),
    /任何一方都不能单独改写已签协议/,
  );
  amendTerms(agreement, [{ obligation_id: 'ob-refund', deadline: '2026-09-15T00:00:00Z' }], { consumer: true, merchant: true });
  assert.equal(obligation(agreement, 'ob-refund').deadline, '2026-09-15T00:00:00Z');
  assert.equal(agreement.version, 2);
  assert.equal(agreement.amendments.length, 1);
});

test('敏感身份仅向当前经办人开放', () => {
  const agreement = createAgreement(sampleInput());
  const handlerView = viewAgreement(agreement, 'mediator-1');
  assert.equal(handlerView.parties.consumer.phone, '13800000000');
  const otherView = viewAgreement(agreement, 'mediator-2');
  assert.equal(otherView.parties.consumer.phone, '***');
  assert.equal(otherView.parties.consumer.id_number, '***');
  assert.equal(otherView.parties.merchant.real_name, '***');
});

test('逾期未完成的义务巡检后标记违约并升级', () => {
  const agreement = createAgreement(sampleInput());
  sweepBreaches(agreement, '2026-09-11T00:00:00Z');
  assert.ok(agreement.obligations.every((ob) => ob.status === OBLIGATION_STATUS.BREACHED));
  assert.equal(agreement.escalations.filter((e) => e.reason === 'deadline_passed').length, 2);
  assert.equal(agreementStatus(agreement), 'breached');
});

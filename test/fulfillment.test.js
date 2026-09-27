import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgreement, signAgreement } from '../src/agreement.js';
import { openCase, recordEvent, summarize, STATUS } from '../src/fulfillment.js';

function makeCase(terms) {
  const agreement = createAgreement({
    id: 'SA-1',
    consumer: { id: 'C-1' },
    merchant: { id: 'M-1' },
    handlerId: 'H-1',
    terms,
  });
  signAgreement(agreement, 'consumer', '2026-09-20T10:00:00Z');
  signAgreement(agreement, 'merchant', '2026-09-20T11:00:00Z');
  return openCase(agreement);
}

const refundTerm = { id: 'OB-R', kind: 'refund', obligor: 'merchant', deadline: '2026-10-01T00:00:00Z', amount: 200 };

function obligationOf(state, id) {
  return state.obligations.find((obligation) => obligation.id === id);
}

test('退款回调足额后义务实际完成', () => {
  const caseFile = makeCase([refundTerm]);
  const state = recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  });
  const obligation = obligationOf(state, 'OB-R');
  assert.equal(obligation.status, STATUS.COMPLETED);
  assert.equal(obligation.remaining, 0);
  assert.equal(summarize(state).completed, 1);
});

test('支付回调重放不会重复完成义务', () => {
  const caseFile = makeCase([refundTerm]);
  const event = {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  };
  recordEvent(caseFile, event);
  const state = recordEvent(caseFile, event);
  const obligation = obligationOf(state, 'OB-R');
  assert.equal(obligation.paidAmount, 200);
  assert.equal(obligation.evidence.length, 1);
  assert.ok(state.timeline.some((entry) => entry.text.includes('重复回调')));
});

test('部分退款累计冲减剩余责任', () => {
  const caseFile = makeCase([refundTerm]);
  let state = recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 80, occurredAt: '2026-09-21T08:00:00Z',
  });
  let obligation = obligationOf(state, 'OB-R');
  assert.equal(obligation.status, STATUS.IN_PROGRESS);
  assert.equal(obligation.remaining, 120);
  state = recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-2', obligationId: 'OB-R', amount: 120, occurredAt: '2026-09-22T08:00:00Z',
  });
  obligation = obligationOf(state, 'OB-R');
  assert.equal(obligation.status, STATUS.COMPLETED);
});

test('义务完成后再收到付款进入重复赔付复核', () => {
  const caseFile = makeCase([refundTerm]);
  recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  });
  const state = recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-2', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T09:00:00Z',
  });
  const obligation = obligationOf(state, 'OB-R');
  assert.equal(obligation.paidAmount, 200);
  assert.ok(state.reviews.some((review) => review.reason === 'duplicate_compensation' && review.status === 'open'));
});

test('物流里程碑完成退货、换新与维修义务', () => {
  const caseFile = makeCase([
    { id: 'OB-T', kind: 'return', obligor: 'consumer', deadline: '2026-10-05T00:00:00Z' },
    { id: 'OB-E', kind: 'exchange', obligor: 'merchant', deadline: '2026-10-06T00:00:00Z' },
    { id: 'OB-F', kind: 'repair', obligor: 'merchant', deadline: '2026-10-07T00:00:00Z' },
  ]);
  recordEvent(caseFile, { type: 'logistics_callback', callbackId: 'LG-1', obligationId: 'OB-T', milestone: 'return_signed', occurredAt: '2026-09-22T00:00:00Z' });
  recordEvent(caseFile, { type: 'logistics_callback', callbackId: 'LG-2', obligationId: 'OB-E', milestone: 'exchange_shipped', occurredAt: '2026-09-23T00:00:00Z' });
  const state = recordEvent(caseFile, { type: 'logistics_callback', callbackId: 'LG-3', obligationId: 'OB-F', milestone: 'repair_completed', occurredAt: '2026-09-24T00:00:00Z' });
  assert.equal(obligationOf(state, 'OB-T').status, STATUS.COMPLETED);
  assert.equal(obligationOf(state, 'OB-E').status, STATUS.COMPLETED);
  assert.equal(obligationOf(state, 'OB-F').status, STATUS.COMPLETED);
});

test('拒收使退货义务回退为履行中', () => {
  const caseFile = makeCase([{ id: 'OB-T', kind: 'return', obligor: 'consumer', deadline: '2026-10-05T00:00:00Z' }]);
  const state = recordEvent(caseFile, { type: 'logistics_callback', callbackId: 'LG-1', obligationId: 'OB-T', milestone: 'return_rejected', occurredAt: '2026-09-22T00:00:00Z' });
  const obligation = obligationOf(state, 'OB-T');
  assert.equal(obligation.status, STATUS.IN_PROGRESS);
  assert.match(obligation.note, /拒收/);
});

test('退货丢失进入人工复核，仅经办人可处理', () => {
  const caseFile = makeCase([{ id: 'OB-T', kind: 'return', obligor: 'consumer', deadline: '2026-10-05T00:00:00Z' }]);
  let state = recordEvent(caseFile, { type: 'logistics_callback', callbackId: 'LG-1', obligationId: 'OB-T', milestone: 'return_lost', occurredAt: '2026-09-22T00:00:00Z' });
  assert.equal(obligationOf(state, 'OB-T').status, STATUS.UNDER_REVIEW);
  const review = state.reviews.find((item) => item.reason === 'return_lost');
  assert.ok(review);
  // 非经办人不能处理复核。
  assert.throws(
    () => recordEvent(caseFile, { type: 'review_resolution', reviewId: review.id, decision: 'resume', handlerId: 'H-2', occurredAt: '2026-09-23T00:00:00Z' }),
    /当前经办人/,
  );
  state = recordEvent(caseFile, { type: 'review_resolution', reviewId: review.id, decision: 'resume', handlerId: 'H-1', occurredAt: '2026-09-23T00:00:00Z' });
  assert.equal(obligationOf(state, 'OB-T').status, STATUS.IN_PROGRESS);
  assert.equal(state.reviews[0].status, 'resolved');
});

test('消费者否认与客观凭证冲突时先进入人工复核', () => {
  const caseFile = makeCase([refundTerm]);
  recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  });
  let state = recordEvent(caseFile, { type: 'consumer_confirmation', obligationId: 'OB-R', confirmed: false, occurredAt: '2026-09-22T08:00:00Z' });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.UNDER_REVIEW);
  const review = state.reviews.find((item) => item.reason === 'confirmation_conflicts_with_evidence');
  assert.ok(review);
  // 经办人核实后确认完成。
  state = recordEvent(caseFile, { type: 'review_resolution', reviewId: review.id, decision: 'confirm_completed', handlerId: 'H-1', occurredAt: '2026-09-23T08:00:00Z' });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.COMPLETED);
});

test('维修义务可凭消费者确认完成，退款义务不接受单方确认', () => {
  const caseFile = makeCase([
    { id: 'OB-F', kind: 'repair', obligor: 'merchant', deadline: '2026-10-07T00:00:00Z' },
    refundTerm,
  ]);
  let state = recordEvent(caseFile, { type: 'consumer_confirmation', obligationId: 'OB-F', confirmed: true, occurredAt: '2026-09-22T08:00:00Z' });
  assert.equal(obligationOf(state, 'OB-F').status, STATUS.COMPLETED);
  state = recordEvent(caseFile, { type: 'consumer_confirmation', obligationId: 'OB-R', confirmed: true, occurredAt: '2026-09-22T09:00:00Z' });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.PROMISED);
  assert.ok(state.reviews.some((review) => review.reason === 'unsupported_confirmation'));
});

test('消费者撤销同意取消未履行义务，已完成义务不受影响', () => {
  const caseFile = makeCase([
    refundTerm,
    { id: 'OB-E', kind: 'exchange', obligor: 'merchant', deadline: '2026-10-06T00:00:00Z' },
  ]);
  recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  });
  const state = recordEvent(caseFile, { type: 'consumer_revocation', occurredAt: '2026-09-22T08:00:00Z' });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.COMPLETED);
  assert.equal(obligationOf(state, 'OB-E').status, STATUS.CANCELLED);
  assert.equal(state.revoked, true);
});

test('商家停业使剩余义务违约并升级', () => {
  const caseFile = makeCase([
    refundTerm,
    { id: 'OB-E', kind: 'exchange', obligor: 'merchant', deadline: '2026-10-06T00:00:00Z' },
  ]);
  recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  });
  const state = recordEvent(caseFile, { type: 'merchant_closure', occurredAt: '2026-09-25T08:00:00Z' });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.COMPLETED);
  assert.equal(obligationOf(state, 'OB-E').status, STATUS.BREACHED);
  assert.ok(state.escalations.some((escalation) => escalation.reason === 'merchant_closure' && escalation.obligationId === 'OB-E'));
});

test('超过期限未完成判定违约并升级', () => {
  const caseFile = makeCase([refundTerm]);
  const state = recordEvent(caseFile, { type: 'deadline_check', now: '2026-10-02T00:00:00Z' });
  const obligation = obligationOf(state, 'OB-R');
  assert.equal(obligation.status, STATUS.BREACHED);
  assert.ok(state.escalations.some((escalation) => escalation.reason === 'deadline_exceeded'));
  assert.equal(summarize(state).breached, 1);
});

test('同一损失不会因多个渠道重复获得赔偿', () => {
  const caseFile = makeCase([
    { ...refundTerm, lossGroupId: 'LOSS-1' },
    { id: 'OB-P', kind: 'refund', obligor: 'platform', deadline: '2026-10-03T00:00:00Z', amount: 200, lossGroupId: 'LOSS-1' },
  ]);
  const state = recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.COMPLETED);
  const peer = obligationOf(state, 'OB-P');
  assert.equal(peer.status, STATUS.CANCELLED);
  assert.match(peer.note, /不再重复赔偿/);
});

test('事件按真实发生顺序回放，与到达顺序无关', () => {
  // 撤销真实发生在退款之前：退款打中已取消义务，进入复核而非完成。
  const caseFile = makeCase([refundTerm]);
  recordEvent(caseFile, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-22T08:00:00Z',
  });
  let state = recordEvent(caseFile, { type: 'consumer_revocation', occurredAt: '2026-09-21T08:00:00Z' });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.CANCELLED);
  assert.ok(state.reviews.some((review) => review.reason === 'payment_after_close'));

  // 退款真实发生在撤销之前：义务已完成，撤销不影响。
  const caseFile2 = makeCase([refundTerm]);
  recordEvent(caseFile2, { type: 'consumer_revocation', occurredAt: '2026-09-22T08:00:00Z' });
  state = recordEvent(caseFile2, {
    type: 'payment_callback', callbackId: 'PAY-1', obligationId: 'OB-R', amount: 200, occurredAt: '2026-09-21T08:00:00Z',
  });
  assert.equal(obligationOf(state, 'OB-R').status, STATUS.COMPLETED);
});

test('未签署协议不能进入履约跟踪', () => {
  const agreement = createAgreement({
    id: 'SA-2',
    consumer: { id: 'C-1' },
    merchant: { id: 'M-1' },
    handlerId: 'H-1',
    terms: [refundTerm],
  });
  assert.throws(() => openCase(agreement), /未签署/);
});

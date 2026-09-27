// 调解协议的生成、签署与修订。
// 协议把每项义务拆成责任方、期限、金额、收发地址与可接受证据；
// 一经双方签署，任何修订都必须双方同意，任何一方都不能单独改写已签协议。

export const OBLIGATION_KINDS = ['refund', 'return', 'exchange', 'repair'];

// 各类义务默认可接受的客观凭证。
const DEFAULT_EVIDENCE = {
  refund: ['payment_callback'],
  return: ['logistics_callback'],
  exchange: ['logistics_callback'],
  repair: ['logistics_callback', 'consumer_confirmation'],
};

export function buildObligation(term, index) {
  if (!OBLIGATION_KINDS.includes(term.kind)) {
    throw new Error(`未知义务类型: ${term.kind}`);
  }
  if (!term.obligor) {
    throw new Error('义务缺少责任方');
  }
  if (!term.deadline) {
    throw new Error('义务缺少期限');
  }
  if (term.kind === 'refund' && !(term.amount > 0)) {
    throw new Error('退款义务缺少金额');
  }
  return {
    id: term.id ?? `OB-${index + 1}`,
    kind: term.kind,
    obligor: term.obligor,
    deadline: term.deadline,
    amount: term.amount ?? null,
    currency: term.currency ?? 'CNY',
    // 同一损失标识：同一损失可能被多个渠道承诺赔偿，只能实际完成一次。
    lossGroupId: term.lossGroupId ?? null,
    addresses: { from: term.shipFrom ?? null, to: term.shipTo ?? null },
    acceptableEvidence: term.evidence ?? DEFAULT_EVIDENCE[term.kind],
  };
}

export function createAgreement({ id, consumer, merchant, handlerId, terms, createdAt = null }) {
  if (!id) {
    throw new Error('协议缺少标识');
  }
  if (!consumer || !merchant) {
    throw new Error('协议缺少当事方');
  }
  if (!handlerId) {
    throw new Error('协议缺少当前经办人');
  }
  if (!Array.isArray(terms) || terms.length === 0) {
    throw new Error('协议缺少义务条款');
  }
  return {
    id,
    version: 1,
    status: 'draft',
    consumer,
    merchant,
    handlerId,
    obligations: terms.map((term, index) => buildObligation(term, index)),
    signatures: {},
    amendments: [],
    createdAt,
  };
}

function assertParty(party) {
  if (!['consumer', 'merchant'].includes(party)) {
    throw new Error(`未知当事方: ${party}`);
  }
}

export function signAgreement(agreement, party, signedAt = new Date().toISOString()) {
  assertParty(party);
  if (agreement.status === 'signed') {
    throw new Error('协议已签署');
  }
  agreement.signatures[party] = signedAt;
  if (agreement.signatures.consumer && agreement.signatures.merchant) {
    agreement.status = 'signed';
  }
  return agreement;
}

// 已签协议只能通过“提出修订 + 双方同意”变更。
export function proposeAmendment(agreement, proposer, changes) {
  if (agreement.status !== 'signed') {
    throw new Error('协议尚未签署，直接修改草稿即可');
  }
  assertParty(proposer);
  const amendment = {
    id: `AM-${agreement.amendments.length + 1}`,
    proposer,
    changes,
    consents: { [proposer]: true },
    status: 'pending',
  };
  agreement.amendments.push(amendment);
  return amendment;
}

export function consentAmendment(agreement, amendmentId, party) {
  assertParty(party);
  const amendment = agreement.amendments.find((item) => item.id === amendmentId);
  if (!amendment) {
    throw new Error(`修订不存在: ${amendmentId}`);
  }
  if (amendment.status !== 'pending') {
    throw new Error('修订已处理');
  }
  amendment.consents[party] = true;
  // 单方同意不生效，必须双方同意才改写协议。
  if (amendment.consents.consumer && amendment.consents.merchant) {
    applyChanges(agreement, amendment.changes);
    agreement.version += 1;
    amendment.status = 'applied';
  }
  return amendment;
}

function applyChanges(agreement, changes) {
  for (const term of changes.addTerms ?? []) {
    agreement.obligations.push(buildObligation(term, agreement.obligations.length));
  }
  for (const { id, patch } of changes.updateObligations ?? []) {
    const obligation = agreement.obligations.find((item) => item.id === id);
    if (!obligation) {
      throw new Error(`义务不存在: ${id}`);
    }
    Object.assign(obligation, patch);
  }
  for (const id of changes.cancelObligations ?? []) {
    agreement.obligations = agreement.obligations.filter((item) => item.id !== id);
  }
}

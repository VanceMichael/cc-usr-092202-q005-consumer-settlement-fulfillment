// 调解协议履约状态机。
// 把协议中的每项义务拆成责任方、期限、金额、收发地址与可接受证据，
// 按真实发生的事件顺序推进状态：支付或物流回调重放不重复完成义务，
// 部分退款、拒收、退货丢失、消费者撤销与商家停业都会改变剩余责任，
// 消费者确认与客观凭证不一致时先进入人工复核。

export const OBLIGATION_STATUS = {
  PROMISED: 'promised', // 已承诺
  IN_PROGRESS: 'in_progress', // 履行中
  FULFILLED: 'fulfilled', // 实际完成
  BREACHED: 'breached', // 违约
  CANCELLED: 'cancelled', // 已解除（撤销同意或损失转移后不再负有）
};

const TERMINAL = new Set([
  OBLIGATION_STATUS.FULFILLED,
  OBLIGATION_STATUS.BREACHED,
  OBLIGATION_STATUS.CANCELLED,
]);

const OBLIGATION_TYPES = ['refund', 'return', 'exchange', 'repair'];

// 敏感身份字段仅向当前经办人开放。
const SENSITIVE_FIELDS = ['real_name', 'phone', 'id_number'];

// 校验协议资料：每项义务必须具备责任方、期限、收发地址与可接受证据，退款义务必须有金额。
export function parseAgreement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('协议资料无效');
  }
  if (!value.id || !value.handler_id || !value.parties || typeof value.parties !== 'object') {
    throw new Error('协议缺少标识、经办人或当事方');
  }
  if (!Array.isArray(value.obligations) || value.obligations.length === 0) {
    throw new Error('协议缺少义务明细');
  }
  const ids = new Set();
  for (const ob of value.obligations) {
    if (!ob.id || ids.has(ob.id)) throw new Error('义务标识无效或重复');
    ids.add(ob.id);
    if (!OBLIGATION_TYPES.includes(ob.type)) throw new Error(`义务类型无效: ${ob.id}`);
    if (!ob.responsible || !ob.deadline) throw new Error(`义务缺少责任方或期限: ${ob.id}`);
    if (!ob.addresses || !ob.addresses.from || !ob.addresses.to) {
      throw new Error(`义务缺少收发地址: ${ob.id}`);
    }
    if (!Array.isArray(ob.evidence) || ob.evidence.length === 0) {
      throw new Error(`义务缺少可接受证据: ${ob.id}`);
    }
    if (ob.type === 'refund' && !(typeof ob.amount === 'number' && ob.amount > 0)) {
      throw new Error(`退款义务缺少有效金额: ${ob.id}`);
    }
  }
  return value;
}

// 基于已签协议生成履约跟踪实例。
export function createAgreement(input) {
  const agreement = parseAgreement(structuredClone(input));
  agreement.version ??= 1;
  agreement.revoked = false;
  agreement.applied_events = [];
  agreement.blocked_events = [];
  agreement.compensated_losses = [];
  agreement.escalations = [];
  agreement.reviews = [];
  agreement.amendments = [];
  for (const ob of agreement.obligations) {
    ob.status = OBLIGATION_STATUS.PROMISED;
    ob.remaining = ob.amount ?? null;
    ob.depends_on ??= null;
    ob.objections = [];
    ob.under_review = false;
    ob.history = [];
  }
  return agreement;
}

function findObligation(agreement, obligationId) {
  const ob = agreement.obligations.find((item) => item.id === obligationId);
  if (!ob) throw new Error(`义务不存在: ${obligationId}`);
  return ob;
}

function openReview(agreement, obligation, reason, lossId = null) {
  obligation.under_review = true;
  const review = {
    id: `review-${agreement.reviews.length + 1}`,
    obligation_id: obligation.id,
    reason,
    loss_id: lossId,
    resolved: false,
  };
  agreement.reviews.push(review);
  return review;
}

// 客观凭证到达后尝试完成义务；存在未解决的消费者异议时先进入人工复核。
function tryFulfill(agreement, obligation, event) {
  const objection = obligation.objections.find((item) => !item.resolved);
  if (objection) {
    obligation.status = OBLIGATION_STATUS.IN_PROGRESS;
    openReview(agreement, obligation, '消费者确认与客观凭证不一致', event.loss_id ?? null);
    return { review: true };
  }
  obligation.status = OBLIGATION_STATUS.FULFILLED;
  obligation.fulfilled_at = event.at ?? null;
  if (event.loss_id) agreement.compensated_losses.push(event.loss_id);
  return { fulfilled: true };
}

// 前置义务完成或灭失后，释放依赖它的后续义务（如退货完成后退款才到期）。
function releaseDependents(agreement, obligation) {
  for (const other of agreement.obligations) {
    if (other.depends_on === obligation.id) {
      other.depends_on = null;
      other.history.push({ note: `前置义务 ${obligation.id} 已了结，本义务到期` });
    }
  }
}

const HANDLERS = {
  // 支付机构退款回调：可多次部分到账，累计达到约定金额才算实际完成。
  payment_callback(agreement, event) {
    const ob = findObligation(agreement, event.obligation_id);
    if (ob.type !== 'refund') throw new Error(`义务 ${ob.id} 不是退款义务`);
    if (TERMINAL.has(ob.status)) return { ignored: 'obligation_terminal' };
    if (ob.depends_on) return { blocked: 'dependency_pending', depends_on: ob.depends_on };
    if (!(typeof event.amount === 'number' && event.amount > 0)) {
      throw new Error('退款金额无效');
    }
    ob.status = OBLIGATION_STATUS.IN_PROGRESS;
    ob.remaining = Math.max(0, (ob.remaining ?? 0) - event.amount);
    ob.history.push({ event: event.event_id, note: `退款到账 ${event.amount}，剩余 ${ob.remaining}` });
    if (ob.remaining === 0) return tryFulfill(agreement, ob, event);
    return { partial: true, remaining: ob.remaining };
  },

  // 物流回调：签收完成义务，拒收不解除义务，丢失则转移损失并释放关联义务。
  logistics_callback(agreement, event) {
    const ob = findObligation(agreement, event.obligation_id);
    if (TERMINAL.has(ob.status)) return { ignored: 'obligation_terminal' };
    switch (event.outcome) {
      case 'signed': {
        const result = tryFulfill(agreement, ob, event);
        if (result.fulfilled) releaseDependents(agreement, ob);
        return result;
      }
      case 'rejected':
        ob.status = OBLIGATION_STATUS.IN_PROGRESS;
        ob.history.push({ event: event.event_id, note: '拒收，义务未解除，责任方需重新履行' });
        return { rejected: true };
      case 'lost':
        ob.status = OBLIGATION_STATUS.CANCELLED;
        ob.history.push({ event: event.event_id, note: '物流丢失，不再要求重复履行，转入损失分担复核' });
        releaseDependents(agreement, ob);
        openReview(agreement, ob, '物流丢失损失分担');
        return { lost: true };
      default:
        throw new Error(`未知物流结果: ${event.outcome}`);
    }
  },

  // 消费者确认：与客观凭证冲突时进入人工复核，已完成的义务也会被拉回。
  consumer_confirm(agreement, event) {
    const ob = findObligation(agreement, event.obligation_id);
    if (event.received) {
      for (const objection of ob.objections) objection.resolved = true;
      ob.history.push({ event: event.event_id, note: '消费者确认收到约定结果' });
      return { confirmed: true };
    }
    ob.objections.push({ at: event.at ?? null, note: event.note ?? '消费者确认未收到约定结果', resolved: false });
    if (ob.status === OBLIGATION_STATUS.FULFILLED) {
      ob.status = OBLIGATION_STATUS.IN_PROGRESS;
      openReview(agreement, ob, '消费者确认与客观凭证不一致');
      return { review: true };
    }
    return { objection: true };
  },

  // 人工复核结论：确认已履行则完成义务，确认未履行则责任方继续履行。
  manual_review_resolve(agreement, event) {
    const review = agreement.reviews.find((item) => item.id === event.review_id && !item.resolved);
    if (!review) throw new Error('复核记录不存在或已结案');
    review.resolved = true;
    review.outcome = event.outcome;
    const ob = findObligation(agreement, review.obligation_id);
    ob.under_review = false;
    for (const objection of ob.objections) objection.resolved = true;
    if (event.outcome === 'confirm_fulfilled') {
      ob.status = OBLIGATION_STATUS.FULFILLED;
      if (review.loss_id && !agreement.compensated_losses.includes(review.loss_id)) {
        agreement.compensated_losses.push(review.loss_id);
      }
      releaseDependents(agreement, ob);
    } else if (event.outcome === 'confirm_unfulfilled') {
      ob.status = OBLIGATION_STATUS.IN_PROGRESS;
      ob.history.push({ event: event.event_id, note: '复核认定未履行，责任方继续履行' });
    } else {
      throw new Error(`未知复核结论: ${event.outcome}`);
    }
    return { resolved: event.outcome };
  },

  // 消费者撤销同意：未终结的剩余义务全部解除，已完成的不回退。
  consumer_revoke(agreement, event) {
    agreement.revoked = true;
    for (const ob of agreement.obligations) {
      if (!TERMINAL.has(ob.status)) {
        ob.status = OBLIGATION_STATUS.CANCELLED;
        ob.history.push({ event: event.event_id, note: '消费者撤销同意，剩余义务解除' });
      }
    }
    return { revoked: true };
  },

  // 商家停业：剩余义务无法履行，按违约升级。
  merchant_closed(agreement, event) {
    let escalated = 0;
    for (const ob of agreement.obligations) {
      if (!TERMINAL.has(ob.status)) {
        ob.status = OBLIGATION_STATUS.BREACHED;
        agreement.escalations.push({ obligation_id: ob.id, reason: 'merchant_closed', at: event.at ?? null });
        escalated += 1;
      }
    }
    return { escalated };
  },
};

// 应用一条履约事件。event_id 幂等：重放的回调不会重复改变义务；
// loss_id 防重复赔偿：同一损失已获赔后，其他渠道的再次赔付会被拦截。
export function applyEvent(agreement, event) {
  if (!event || !event.event_id || !event.type) throw new Error('事件缺少标识或类型');
  if (agreement.applied_events.includes(event.event_id)) {
    return { duplicate: true };
  }
  if (event.loss_id && agreement.compensated_losses.includes(event.loss_id)) {
    agreement.blocked_events.push({ event_id: event.event_id, reason: 'loss_already_compensated' });
    return { blocked: 'loss_already_compensated' };
  }
  const handler = HANDLERS[event.type];
  if (!handler) throw new Error(`未知事件类型: ${event.type}`);
  const result = handler(agreement, event);
  agreement.applied_events.push(event.event_id);
  return result;
}

// 逾期巡检：超过期限仍未完成且不在复核中的义务标记为违约并升级。
export function sweepBreaches(agreement, now) {
  const current = Date.parse(now);
  for (const ob of agreement.obligations) {
    if (!TERMINAL.has(ob.status) && !ob.under_review && Date.parse(ob.deadline) < current) {
      ob.status = OBLIGATION_STATUS.BREACHED;
      agreement.escalations.push({ obligation_id: ob.id, reason: 'deadline_passed', at: now });
    }
  }
  return agreement.escalations;
}

// 已签协议不可由任何一方单独改写，变更须双方确认后留痕。
export function amendTerms(agreement, changes, approvals = {}) {
  if (!approvals.consumer || !approvals.merchant) {
    throw new Error('任何一方都不能单独改写已签协议');
  }
  for (const change of changes) {
    const ob = findObligation(agreement, change.obligation_id);
    if (TERMINAL.has(ob.status)) throw new Error(`义务已终结，不可改写: ${ob.id}`);
    if (change.deadline) ob.deadline = change.deadline;
    if (change.addresses) ob.addresses = { ...ob.addresses, ...change.addresses };
    if (typeof change.amount === 'number' && change.amount > 0) {
      ob.remaining = Math.max(0, (ob.remaining ?? 0) + (change.amount - ob.amount));
      ob.amount = change.amount;
    }
    ob.history.push({ note: '经双方确认变更协议条款' });
  }
  agreement.version += 1;
  agreement.amendments.push({ changes, approvals: { consumer: true, merchant: true } });
  return agreement;
}

// 协议整体状态：区分已承诺、履行中、实际完成与违约。
export function agreementStatus(agreement) {
  if (agreement.revoked) return 'revoked';
  const statuses = agreement.obligations.map((ob) => ob.status);
  if (statuses.some((s) => s === OBLIGATION_STATUS.BREACHED)) return 'breached';
  if (statuses.every((s) => TERMINAL.has(s))) {
    return statuses.every((s) => s === OBLIGATION_STATUS.CANCELLED) ? 'cancelled' : 'fulfilled';
  }
  if (statuses.some((s) => s === OBLIGATION_STATUS.IN_PROGRESS)) return 'in_progress';
  return 'promised';
}

// 脱敏视图：敏感身份仅向当前经办人开放。
export function viewAgreement(agreement, viewerId) {
  const view = structuredClone(agreement);
  if (viewerId !== agreement.handler_id) {
    for (const party of Object.values(view.parties)) {
      for (const field of SENSITIVE_FIELDS) {
        if (field in party) party[field] = '***';
      }
    }
  }
  return view;
}

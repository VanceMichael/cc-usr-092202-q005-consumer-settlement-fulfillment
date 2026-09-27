// 履约跟踪引擎：把支付、物流、消费者确认等事件按真实发生顺序回放，
// 推导每项义务的状态（已承诺/履行中/实际完成/违约/人工复核/已取消）。
//
// 关键规则：
// - 支付与物流回调按 callbackId 去重，重放不会重复完成义务；
// - 部分退款累计冲减剩余责任，拒收、退货丢失、消费者撤销同意、商家停业
//   都按真实发生顺序改变剩余义务；
// - 消费者确认与客观凭证不一致时先进入人工复核，只有当前经办人能处理复核；
// - 同一损失不会被多个渠道重复赔偿。

export const STATUS = {
  PROMISED: 'promised', // 已承诺
  IN_PROGRESS: 'in_progress', // 履行中
  COMPLETED: 'completed', // 实际完成
  BREACHED: 'breached', // 违约
  CANCELLED: 'cancelled', // 已取消（撤销同意或损失已被其他渠道覆盖）
  UNDER_REVIEW: 'under_review', // 人工复核
};

// 物流里程碑与义务类型的对应关系。
const MILESTONE_COMPLETES = {
  return_signed: 'return',
  exchange_shipped: 'exchange',
  repair_completed: 'repair',
};

export function openCase(agreement) {
  if (agreement.status !== 'signed') {
    throw new Error('协议未签署，不能进入履约跟踪');
  }
  return { agreement, log: [], seq: 0 };
}

export function recordEvent(caseFile, event) {
  if (!event || !event.type) {
    throw new Error('事件缺少类型');
  }
  // 复核处理涉及敏感信息，只有当前经办人可以提交处理结果。
  if (event.type === 'review_resolution' && event.handlerId !== caseFile.agreement.handlerId) {
    throw new Error('只有当前经办人可以处理人工复核');
  }
  caseFile.log.push({ ...event, seq: caseFile.seq++ });
  return derive(caseFile);
}

// 从事件日志重新推导当前状态。事件按真实发生时间排序，
// 与到达顺序无关；同一日志重放结果一致。
export function derive(caseFile) {
  const events = [...caseFile.log].sort((a, b) => occurredKey(a) - occurredKey(b) || a.seq - b.seq);
  const state = initialState(caseFile.agreement);
  for (const event of events) {
    reduce(state, event);
  }
  return state;
}

function occurredKey(event) {
  const parsed = Date.parse(event.occurredAt);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function initialState(agreement) {
  return {
    agreementId: agreement.id,
    version: agreement.version,
    handlerId: agreement.handlerId,
    obligations: agreement.obligations.map((obligation) => ({
      ...obligation,
      status: STATUS.PROMISED,
      paidAmount: 0,
      remaining: obligation.amount,
      evidence: [],
      note: null,
      completedAt: null,
    })),
    reviews: [],
    escalations: [],
    timeline: [],
    callbacksSeen: new Set(),
    revoked: false,
    merchantClosed: false,
  };
}

// 按状态汇总，区分已承诺、履行中、实际完成、违约等。
export function summarize(state) {
  const counts = {
    promised: 0,
    inProgress: 0,
    completed: 0,
    breached: 0,
    cancelled: 0,
    underReview: 0,
  };
  for (const obligation of state.obligations) {
    if (obligation.status === STATUS.PROMISED) counts.promised += 1;
    else if (obligation.status === STATUS.IN_PROGRESS) counts.inProgress += 1;
    else if (obligation.status === STATUS.COMPLETED) counts.completed += 1;
    else if (obligation.status === STATUS.BREACHED) counts.breached += 1;
    else if (obligation.status === STATUS.CANCELLED) counts.cancelled += 1;
    else if (obligation.status === STATUS.UNDER_REVIEW) counts.underReview += 1;
  }
  return counts;
}

function findObligation(state, id) {
  return state.obligations.find((obligation) => obligation.id === id);
}

function log(state, event, text) {
  state.timeline.push({ at: event.occurredAt ?? null, text });
}

function openReview(state, obligationId, reason, detail, event) {
  const id = `RV-${obligationId}-${reason}`;
  if (state.reviews.some((review) => review.id === id && review.status === 'open')) {
    return;
  }
  state.reviews.push({
    id,
    obligationId,
    reason,
    detail,
    status: 'open',
    openedAt: event.occurredAt ?? null,
    resolution: null,
  });
  log(state, event, `进入人工复核: ${detail}`);
}

function escalate(state, obligationId, reason, event) {
  const id = `ESC-${obligationId}-${reason}`;
  if (state.escalations.some((escalation) => escalation.id === id)) {
    return;
  }
  state.escalations.push({ id, obligationId, reason, at: event.occurredAt ?? null });
  log(state, event, `违约升级: ${reason}（义务 ${obligationId}）`);
}

// 完成义务，并取消同一损失组内尚未履行的其他义务，避免重复赔偿。
function completeObligation(state, obligation, event, evidence) {
  obligation.status = STATUS.COMPLETED;
  obligation.completedAt = event.occurredAt ?? null;
  obligation.evidence.push(evidence);
  log(state, event, `义务 ${obligation.id} 实际完成（凭证: ${evidence.kind}）`);
  for (const peer of state.obligations) {
    if (
      peer.id !== obligation.id
      && peer.lossGroupId
      && peer.lossGroupId === obligation.lossGroupId
      && [STATUS.PROMISED, STATUS.IN_PROGRESS].includes(peer.status)
    ) {
      peer.status = STATUS.CANCELLED;
      peer.note = `同一损失已由 ${obligation.id} 赔付，不再重复赔偿`;
      log(state, event, `义务 ${peer.id} 取消：${peer.note}`);
    }
  }
}

function reduce(state, event) {
  // 回调去重：同一 callbackId 重放直接忽略。
  if (event.callbackId) {
    if (state.callbacksSeen.has(event.callbackId)) {
      log(state, event, `重复回调 ${event.callbackId} 已忽略`);
      return;
    }
    state.callbacksSeen.add(event.callbackId);
  }

  switch (event.type) {
    case 'payment_callback':
      return reducePayment(state, event);
    case 'logistics_callback':
      return reduceLogistics(state, event);
    case 'consumer_confirmation':
      return reduceConfirmation(state, event);
    case 'consumer_revocation':
      return reduceRevocation(state, event);
    case 'merchant_closure':
      return reduceClosure(state, event);
    case 'deadline_check':
      return reduceDeadlineCheck(state, event);
    case 'review_resolution':
      return reduceReviewResolution(state, event);
    default:
      log(state, event, `未知事件类型 ${event.type} 已忽略`);
  }
}

function reducePayment(state, event) {
  const obligation = findObligation(state, event.obligationId);
  if (!obligation) {
    openReview(state, event.obligationId ?? 'unknown', 'unknown_obligation', `支付回调指向不存在的义务 ${event.obligationId}`, event);
    return;
  }
  if (obligation.status === STATUS.COMPLETED) {
    // 义务已完成又收到付款，疑似重复赔付，进入人工复核且不再入账。
    openReview(state, obligation.id, 'duplicate_compensation', `义务 ${obligation.id} 已完成，又收到支付回调 ${event.callbackId}`, event);
    return;
  }
  if ([STATUS.CANCELLED, STATUS.BREACHED].includes(obligation.status)) {
    openReview(state, obligation.id, 'payment_after_close', `义务 ${obligation.id} 已${obligation.status === STATUS.CANCELLED ? '取消' : '违约'}，仍收到支付回调`, event);
    return;
  }
  if (obligation.status === STATUS.UNDER_REVIEW) {
    log(state, event, `义务 ${obligation.id} 复核期间收到支付回调，暂缓入账`);
    return;
  }
  obligation.paidAmount += event.amount;
  obligation.remaining = obligation.amount == null ? null : Math.max(0, obligation.amount - obligation.paidAmount);
  const evidence = { kind: 'payment_callback', ref: event.callbackId, amount: event.amount, at: event.occurredAt ?? null };
  if (obligation.amount != null && obligation.paidAmount >= obligation.amount) {
    completeObligation(state, obligation, event, evidence);
  } else {
    obligation.evidence.push(evidence);
    obligation.status = STATUS.IN_PROGRESS;
    log(state, event, `义务 ${obligation.id} 部分退款 ${event.amount}，剩余 ${obligation.remaining}`);
  }
}

function reduceLogistics(state, event) {
  const obligation = findObligation(state, event.obligationId);
  if (!obligation) {
    openReview(state, event.obligationId ?? 'unknown', 'unknown_obligation', `物流回调指向不存在的义务 ${event.obligationId}`, event);
    return;
  }
  const completedKind = MILESTONE_COMPLETES[event.milestone];
  if (completedKind) {
    if (obligation.kind !== completedKind) {
      openReview(state, obligation.id, 'milestone_mismatch', `里程碑 ${event.milestone} 与义务类型 ${obligation.kind} 不符`, event);
      return;
    }
    if (obligation.status === STATUS.COMPLETED) {
      openReview(state, obligation.id, 'duplicate_fulfillment', `义务 ${obligation.id} 已完成，又收到里程碑 ${event.milestone}`, event);
      return;
    }
    if ([STATUS.CANCELLED, STATUS.BREACHED].includes(obligation.status)) {
      openReview(state, obligation.id, 'fulfillment_after_close', `义务 ${obligation.id} 已关闭，仍收到里程碑 ${event.milestone}`, event);
      return;
    }
    completeObligation(state, obligation, event, { kind: 'logistics_callback', ref: event.callbackId, milestone: event.milestone });
    return;
  }
  if (event.milestone === 'return_rejected') {
    if (obligation.status === STATUS.COMPLETED) {
      openReview(state, obligation.id, 'rejected_after_signed', `退货已签收又出现拒收记录`, event);
      return;
    }
    obligation.status = STATUS.IN_PROGRESS;
    obligation.note = '退货被拒收，等待重新寄回';
    log(state, event, `义务 ${obligation.id} 被拒收，回退为履行中`);
    return;
  }
  if (event.milestone === 'return_lost') {
    if (obligation.status === STATUS.COMPLETED) {
      openReview(state, obligation.id, 'lost_after_signed', `退货已签收又出现丢失记录`, event);
      return;
    }
    obligation.status = STATUS.UNDER_REVIEW;
    openReview(state, obligation.id, 'return_lost', '退货在途丢失，需认定责任并重排剩余义务', event);
    return;
  }
  log(state, event, `未识别的物流里程碑 ${event.milestone} 已忽略`);
}

function reduceConfirmation(state, event) {
  const obligation = findObligation(state, event.obligationId);
  if (!obligation) {
    openReview(state, event.obligationId ?? 'unknown', 'unknown_obligation', `消费者确认指向不存在的义务 ${event.obligationId}`, event);
    return;
  }
  if (event.confirmed === false) {
    if (obligation.status === STATUS.COMPLETED) {
      // 客观凭证显示已完成，但消费者否认收到约定结果：先进入人工复核。
      obligation.status = STATUS.UNDER_REVIEW;
      openReview(state, obligation.id, 'confirmation_conflicts_with_evidence', '客观凭证显示已完成，但消费者否认收到约定结果', event);
    } else {
      log(state, event, `消费者确认义务 ${obligation.id} 尚未收到结果`);
    }
    return;
  }
  if (obligation.status === STATUS.COMPLETED) {
    log(state, event, `消费者确认与凭证一致，义务 ${obligation.id} 维持完成`);
    return;
  }
  if ([STATUS.CANCELLED, STATUS.BREACHED].includes(obligation.status)) {
    openReview(state, obligation.id, 'confirmation_after_close', `义务 ${obligation.id} 已关闭，消费者却确认完成`, event);
    return;
  }
  if (obligation.acceptableEvidence.includes('consumer_confirmation')) {
    completeObligation(state, obligation, event, { kind: 'consumer_confirmation', ref: event.confirmedBy ?? null });
  } else {
    openReview(state, obligation.id, 'unsupported_confirmation', `义务 ${obligation.id} 不接受消费者确认作为完成凭证`, event);
  }
}

function reduceRevocation(state, event) {
  state.revoked = true;
  for (const obligation of state.obligations) {
    if ([STATUS.PROMISED, STATUS.IN_PROGRESS, STATUS.UNDER_REVIEW].includes(obligation.status)) {
      obligation.status = STATUS.CANCELLED;
      obligation.note = '消费者撤销同意，义务取消';
      log(state, event, `义务 ${obligation.id} 取消：消费者撤销同意`);
    }
  }
  for (const review of state.reviews) {
    if (review.status === 'open') {
      review.status = 'resolved';
      review.resolution = { decision: 'revoked', note: '消费者撤销同意，复核终止', by: null, at: event.occurredAt ?? null };
    }
  }
}

function reduceClosure(state, event) {
  state.merchantClosed = true;
  for (const obligation of state.obligations) {
    if ([STATUS.PROMISED, STATUS.IN_PROGRESS, STATUS.UNDER_REVIEW].includes(obligation.status)) {
      obligation.status = STATUS.BREACHED;
      obligation.note = '商家停业，无法继续履行';
      escalate(state, obligation.id, 'merchant_closure', event);
    }
  }
}

function reduceDeadlineCheck(state, event) {
  const now = Date.parse(event.now ?? event.occurredAt);
  if (!Number.isFinite(now)) {
    throw new Error('deadline_check 事件缺少有效时间');
  }
  for (const obligation of state.obligations) {
    if (
      [STATUS.PROMISED, STATUS.IN_PROGRESS].includes(obligation.status)
      && Date.parse(obligation.deadline) < now
    ) {
      obligation.status = STATUS.BREACHED;
      obligation.note = '超过期限仍未完成';
      escalate(state, obligation.id, 'deadline_exceeded', event);
    }
  }
}

function reduceReviewResolution(state, event) {
  const review = state.reviews.find((item) => item.id === event.reviewId);
  if (!review || review.status !== 'open') {
    log(state, event, `复核 ${event.reviewId} 不存在或已处理`);
    return;
  }
  review.status = 'resolved';
  review.resolution = { decision: event.decision, note: event.note ?? null, by: event.handlerId, at: event.occurredAt ?? null };
  const obligation = findObligation(state, review.obligationId);
  if (!obligation) {
    return;
  }
  if (event.decision === 'confirm_completed') {
    completeObligation(state, obligation, event, { kind: 'manual_review', ref: review.id });
  } else if (event.decision === 'resume') {
    obligation.status = STATUS.IN_PROGRESS;
    obligation.note = event.note ?? '复核后继续履行';
    log(state, event, `义务 ${obligation.id} 复核后继续履行`);
  } else if (event.decision === 'cancel') {
    obligation.status = STATUS.CANCELLED;
    obligation.note = event.note ?? '复核后取消';
    log(state, event, `义务 ${obligation.id} 复核后取消`);
  }
}

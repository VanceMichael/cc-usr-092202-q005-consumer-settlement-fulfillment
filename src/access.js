// 访问控制：敏感身份信息仅向当前经办人开放，
// 其他角色（包括非经办调解员、对应当事方）只能看到脱敏视图。

const SENSITIVE_FIELDS = ['realName', 'phone', 'idNumber', 'address'];
const MASK = '***';

function maskParty(party) {
  if (!party) {
    return;
  }
  for (const field of SENSITIVE_FIELDS) {
    if (field in party) {
      party[field] = MASK;
    }
  }
}

export function viewAgreement(agreement, viewerId) {
  const copy = structuredClone(agreement);
  if (viewerId === agreement.handlerId) {
    return copy;
  }
  maskParty(copy.consumer);
  maskParty(copy.merchant);
  // 义务的收发地址可能包含消费者住址，同样需要脱敏。
  for (const obligation of copy.obligations ?? []) {
    if (obligation.addresses) {
      obligation.addresses = {
        from: obligation.addresses.from == null ? null : MASK,
        to: obligation.addresses.to == null ? null : MASK,
      };
    }
  }
  return copy;
}

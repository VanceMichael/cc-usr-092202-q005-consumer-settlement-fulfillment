// 读取并检查共享领域资料。
export function parseRecords(raw) {
  const value = JSON.parse(raw);
  if (!value.domain || !value.version || !value.sample_id || !Array.isArray(value.actors) || value.actors.length < 2 || !Array.isArray(value.records) || value.records.length < 2) {
    throw new Error('领域资料缺少必要字段');
  }
  const ids = new Set(value.records.map((record) => record.id));
  if (ids.size !== value.records.length || value.records.some((record) => !record.id)) { throw new Error('领域记录标识无效'); }
  return value;
}

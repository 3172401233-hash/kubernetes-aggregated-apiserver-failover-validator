// resourceVersion 工具。
// 这里对 resourceVersion 的处理采用一个可比较的模型：数字型 RV 按 BigInt 比较，
// 非数字型 RV 视为不透明版本，无法跨后端比较，因此一律判为不兼容。

export function resourceKey(group, version, plural) {
  return `${group || ''}/${version}/${plural}`;
}

export function groupVersionKey(group, version) {
  return `${group || ''}/${version}`;
}

export function parseResourceVersion(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

// 候选后端 RV 与缓存 RV 的关系。
export const RV_STATUS = Object.freeze({
  EQUAL: 'EQUAL',
  NEWER: 'NEWER',
  REGRESSED: 'REGRESSED',
  INCOMPATIBLE: 'INCOMPATIBLE',
});

// 比较“新后端即将提供的 RV”与“缓存/长连接当前持有的 RV”。
export function compareResourceVersion(candidateRv, cachedRv) {
  const candidate = parseResourceVersion(candidateRv);
  const cached = parseResourceVersion(cachedRv);
  if (candidate === null || cached === null) return RV_STATUS.INCOMPATIBLE;
  if (candidate === cached) return RV_STATUS.EQUAL;
  return candidate > cached ? RV_STATUS.NEWER : RV_STATUS.REGRESSED;
}

// 新旧后端不能同时返回不兼容的 resourceVersion：
// 只要有一个 RV 不透明（非数字），或新后端落后于缓存，就不能做无缝切换。
export function isResourceVersionCompatible(candidateRv, cachedRv) {
  const status = compareResourceVersion(candidateRv, cachedRv);
  return status === RV_STATUS.EQUAL || status === RV_STATUS.NEWER;
}

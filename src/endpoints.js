import { groupVersionKey, resourceKey } from './rv.js';

export function isEndpointHealthy(endpoint) {
  return Boolean(endpoint && endpoint.ready && endpoint.serving);
}

// 版本偏差判定：主备后端的 major 必须相同，minor 偏差不得超过 1。
export function evaluateVersionSkew(primaryVersion, candidateVersion) {
  const majorSkew = candidateVersion.major !== primaryVersion.major;
  const minorSkew = Math.abs(candidateVersion.minor - primaryVersion.minor) > 1;
  const compatible = !majorSkew && !minorSkew;
  const reasons = [];
  if (majorSkew) reasons.push(`major 偏差: ${primaryVersion.major} -> ${candidateVersion.major}`);
  if (minorSkew) reasons.push(`minor 偏差超过 1: ${primaryVersion.minor} -> ${candidateVersion.minor}`);
  return {
    compatible,
    primary: primaryVersion,
    candidate: candidateVersion,
    reasons,
  };
}

// discovery 评估。
// 关键规则：部分 discovery 成功绝不等于可用。
// 只有候选后端返回了期望集合中的每一个资源，才认为 discovery 完整。
export function evaluateDiscovery(expectedResources, discovery) {
  const expectedKeys = expectedResources.map((r) => resourceKey(r.group, r.version, r.plural));
  const servedKeys = new Set((discovery?.returnedResources ?? []).map(
    (r) => resourceKey(r.group, r.version, r.plural),
  ));

  const missingResources = expectedResources
    .filter((r) => !servedKeys.has(resourceKey(r.group, r.version, r.plural)))
    .map((r) => ({ ...r }));

  const missingGroupVersions = [...new Set(
    missingResources.map((r) => groupVersionKey(r.group, r.version)),
  )].map((key) => {
    const [group, version] = key.split('/');
    return { group, version };
  });

  const extraResources = (discovery?.returnedResources ?? [])
    .filter((r) => !expectedKeys.includes(resourceKey(r.group, r.version, r.plural)))
    .map((r) => ({ ...r }));

  const complete = missingResources.length === 0 && Boolean(discovery?.complete);

  return {
    complete,
    partial: !complete,
    expectedCount: expectedResources.length,
    servedCount: discovery?.returnedResources?.length ?? 0,
    missingResources,
    missingGroupVersions,
    extraResources,
  };
}

// 候选选择优先级：优先主角色（回切），其次按优先级和名称保证确定性。
function candidateRank(endpoint, activeId, preferPrimary) {
  if (endpoint.id === activeId) return Number.POSITIVE_INFINITY;
  const rolePenalty = preferPrimary && endpoint.role === 'primary' ? 0 : 1;
  return rolePenalty * 1_000_000 + (endpoint.priority ?? 100) * 1000;
}

// 从端点列表中挑选健康的切换候选。
export function selectCandidate(endpoints, activeId, preferPrimary = false) {
  const healthy = endpoints.filter((endpoint) => isEndpointHealthy(endpoint) && endpoint.id !== activeId);
  if (healthy.length === 0) return null;
  healthy.sort((left, right) => {
    const rankDelta = candidateRank(left, activeId, preferPrimary) - candidateRank(right, activeId, preferPrimary);
    if (rankDelta !== 0) return rankDelta;
    return left.id.localeCompare(right.id);
  });
  return healthy[0];
}

import { CACHE_ACTION } from './constants.js';
import { RV_STATUS, compareResourceVersion, resourceKey } from './rv.js';

function emptyActions() {
  return {
    mode: 'none',
    relist: [],
    drop: [],
    incompatible: [],
    watches: [],
    summary: { relist: 0, drop: 0, restartWatch: 0, invalidateAll: 0 },
  };
}

// 根据候选后端的 discovery、resourceVersion 与现有客户端缓存，推导缓存动作。
// force=true 表示强制切换：此时即使 RV 不兼容也要推进，但缓存必须整体失效。
export function planCacheActions({ expectedResources, discovery, backend, cache, force = false }) {
  const actions = emptyActions();
  const served = new Map(
    (discovery?.returnedResources ?? []).map((resource) => [
      resourceKey(resource.group, resource.version, resource.plural),
      resource,
    ]),
  );
  const servedRv = new Map(Object.entries(backend?.resourceVersions ?? {}));
  const cachedEntries = new Map(
    (cache?.resources ?? []).map((entry) => [entry.resourceKey, entry]),
  );

  for (const expected of expectedResources) {
    const key = resourceKey(expected.group, expected.version, expected.plural);
    const cached = cachedEntries.get(key);

    // 新后端 discovery 缺少该资源：缓存条目必须丢弃，避免客户端继续看到已消失的资源。
    if (!served.has(key)) {
      actions.drop.push({ resourceKey: key, reason: 'missing-from-discovery' });
      continue;
    }

    if (!cached) {
      // 之前没有缓存，首次拉取即可，不算失效动作。
      continue;
    }

    // discovery 报告该资源被截断：列表不完整，至少需要重新 relist。
    if (served.get(key).truncated) {
      actions.relist.push({ resourceKey: key, reason: 'truncated-list' });
      continue;
    }

    const candidateRv = servedRv.get(key);
    const status = compareResourceVersion(candidateRv, cached.resourceVersion);

    if (status === RV_STATUS.INCOMPATIBLE) {
      actions.incompatible.push({ resourceKey: key, cachedRv: cached.resourceVersion, candidateRv });
      continue;
    }
    if (status === RV_STATUS.REGRESSED) {
      actions.incompatible.push({
        resourceKey: key,
        cachedRv: cached.resourceVersion,
        candidateRv,
        reason: 'resource-version-regression',
      });
      continue;
    }
    if (status === RV_STATUS.NEWER) {
      actions.relist.push({ resourceKey: key, fromRv: cached.resourceVersion, toRv: candidateRv });
    }
    // EQUAL：缓存仍然可信，KEEP。
  }

  // watch 长连接的 RV 续传判定。
  for (const watch of cache?.watches ?? []) {
    if (!watch.active) continue;
    const candidateRv = servedRv.get(watch.resourceKey);
    const status = compareResourceVersion(candidateRv, watch.resourceVersion);
    if (status === RV_STATUS.EQUAL || status === RV_STATUS.NEWER) {
      actions.watches.push({ watchId: watch.id, resourceKey: watch.resourceKey, action: 'resume', rv: candidateRv });
    } else {
      actions.watches.push({
        watchId: watch.id,
        resourceKey: watch.resourceKey,
        action: 'restart',
        reason: status === RV_STATUS.REGRESSED ? 'rv-regression' : 'opaque-rv',
      });
    }
  }

  const incompatible = actions.incompatible.length > 0 || actions.watches.some((watch) => watch.action === 'restart');
  if (incompatible && !force) {
    actions.mode = 'blocked';
  } else if (incompatible && force) {
    actions.mode = CACHE_ACTION.INVALIDATE_ALL.toLowerCase();
    actions.summary.invalidateAll = 1;
  } else {
    actions.mode = 'targeted';
  }

  actions.summary = {
    relist: actions.relist.length,
    drop: actions.drop.length,
    restartWatch: actions.watches.filter((watch) => watch.action === 'restart').length,
    invalidateAll: actions.summary.invalidateAll,
  };
  return actions;
}

// 按计划真正更新缓存（模拟器使用，保持纯函数：返回新缓存而不修改入参）。
export function applyCacheActions(cache, actions, discovery, backend) {
  const next = structuredClone(cache ?? { resources: [], watches: [] });
  next.resources = next.resources ?? [];
  next.watches = next.watches ?? [];

  if (actions.mode === CACHE_ACTION.INVALIDATE_ALL.toLowerCase()) {
    return { resources: [], watches: next.watches.map((watch) => ({ ...watch, active: false })) };
  }

  const dropKeys = new Set(actions.drop.map((item) => item.resourceKey));
  next.resources = next.resources.filter((entry) => !dropKeys.has(entry.resourceKey));

  const relistKeys = new Set(actions.relist.map((item) => item.resourceKey));
  const rvMap = new Map(Object.entries(backend?.resourceVersions ?? {}));
  for (const entry of next.resources) {
    if (relistKeys.has(entry.resourceKey)) {
      entry.resourceVersion = rvMap.get(entry.resourceKey) ?? entry.resourceVersion;
      entry.syncedFrom = backend?.id;
    }
  }

  const restartWatchIds = new Set(
    actions.watches.filter((watch) => watch.action === 'restart').map((watch) => watch.watchId),
  );
  for (const watch of next.watches) {
    if (restartWatchIds.has(watch.id)) watch.active = false;
  }

  // discovery 中被截断的资源同样视为尚未同步。
  for (const resource of discovery?.returnedResources ?? []) {
    if (!resource.truncated) continue;
    const key = resourceKey(resource.group, resource.version, resource.plural);
    const entry = next.resources.find((item) => item.resourceKey === key);
    if (entry) entry.fullyListed = false;
  }

  return next;
}

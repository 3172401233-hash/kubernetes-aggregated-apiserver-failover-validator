import { DECISION, PHASE, RETRY_AFTER_MS } from './constants.js';
import { compareResourceVersion, RV_STATUS, resourceKey } from './rv.js';

const MUTATING_VERBS = new Set(['create', 'update', 'patch', 'delete', 'deletecollection']);
const SERVING_PHASES = new Set([PHASE.STABLE, PHASE.COOLDOWN]);

function reject(decision, reason, extra = {}) {
  return { decision, reason, retryAfterMs: decision === DECISION.RETRY_503 ? RETRY_AFTER_MS : undefined, ...extra };
}

function requestResourceKey(request) {
  return resourceKey(request.group, request.version, request.plural);
}

// 评估单个客户端请求在当前切换上下文中应当如何处置。
export function evaluateRequest(request, context) {
  const { phase, discoveryEvaluation, cache, backend, cacheActions } = context;
  const key = requestResourceKey(request);
  const verb = String(request.verb).toLowerCase();

  // 1. 切换窗口（SUSPECT/DRAIN/VERIFY/RESET）内，写入和 watch 一律拒绝，避免双写与脑裂。
  if (!SERVING_PHASES.has(phase)) {
    if (MUTATING_VERBS.has(verb)) {
      return reject(DECISION.RETRY_503, 'failover-in-progress: mutating request frozen');
    }
    if (verb === 'watch') {
      return reject(DECISION.RETRY_503, 'failover-in-progress: watch suspended');
    }
    // 读请求也必须等 discovery/缓存一致后再放行。
    return reject(DECISION.RETRY_503, 'failover-in-progress: read held until cache reconciles');
  }

  // 2. discovery 不完整时，相关资源不能对外宣称可用。
  const missing = discoveryEvaluation?.missingResources?.some(
    (resource) => resourceKey(resource.group, resource.version, resource.plural) === key,
  );
  if (missing) {
    if (verb === 'watch') return reject(DECISION.RETRY_503, 'discovery-incomplete: watch cannot start');
    return reject(DECISION.NOT_FOUND_404, 'resource missing from aggregated discovery');
  }

  // 3. 缓存已被整体失效，或该资源被标记丢弃时不能返回陈旧数据。
  if (cacheActions?.mode === 'invalidate_all') {
    return reject(DECISION.RETRY_503, 'cache invalidated: relist required before serving');
  }
  const cacheKnown = (cache?.resources ?? []).some((entry) => entry.resourceKey === key);
  if (!cacheKnown) {
    return reject(DECISION.RETRY_503, 'cache warming: resource not relisted after failover');
  }
  const dropped = cacheActions?.drop?.some((item) => item.resourceKey === key);
  if (dropped) {
    return reject(DECISION.NOT_FOUND_404, 'cached resource dropped due to discovery gap');
  }

  // 4. 请求携带的 resourceVersion 落后于新后端 => 410，要求从最新 RV 重新 list/watch。
  if (request.resourceVersion !== undefined) {
    const candidateRv = backend?.resourceVersions?.[key];
    const status = compareResourceVersion(candidateRv, request.resourceVersion);
    if (status === RV_STATUS.REGRESSED || status === RV_STATUS.INCOMPATIBLE) {
      return reject(DECISION.GONE_410, 'stale or incompatible resourceVersion', {
        latestResourceVersion: candidateRv,
      });
    }
  }

  return { decision: DECISION.PROCEED, reason: 'served-by-active', backend: backend?.id };
}

export function evaluateRequests(requests, context) {
  return (requests ?? []).map((request) => ({ request, ...evaluateRequest(request, context) }));
}

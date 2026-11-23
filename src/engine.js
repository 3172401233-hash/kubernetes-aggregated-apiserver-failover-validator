import { PHASE, REASON } from './constants.js';
import { planCacheActions } from './cache.js';
import {
  evaluateDiscovery,
  evaluateVersionSkew,
  isEndpointHealthy,
  selectCandidate,
} from './endpoints.js';
import { evaluateRequests } from './requests.js';

export const DEFAULT_POLICY = Object.freeze({
  cooldownMs: 30_000,
  preferPrimary: true,
  force: false,
});

export function createController(activeEndpointId) {
  return {
    phase: PHASE.STABLE,
    activeEndpointId,
    candidateEndpointId: null,
    drainMarked: false,
    cacheResetDone: false,
    lastSwitchAt: 0,
    failoverCount: 0,
  };
}

function getEndpoint(snapshot, id) {
  return snapshot.endpoints.find((endpoint) => endpoint.id === id) ?? null;
}

function getBackend(snapshot, id) {
  return snapshot.backends?.[id] ?? null;
}

function getDiscovery(snapshot, id) {
  return snapshot.discovery?.perEndpoint?.[id] ?? { complete: false, returnedResources: [] };
}

// 对某个候选后端做完整校验：端点健康 -> discovery 完整 -> 版本偏差 -> RV 兼容。
function evaluateCandidate(snapshot, candidate, policy) {
  const candidateDiscovery = getDiscovery(snapshot, candidate.id);
  const candidateBackend = getBackend(snapshot, candidate.id);
  const primaryEndpoint = snapshot.endpoints.find((endpoint) => endpoint.role === 'primary');
  const primaryBackend = primaryEndpoint ? getBackend(snapshot, primaryEndpoint.id) : null;

  const discoveryEvaluation = evaluateDiscovery(snapshot.expectedResources, candidateDiscovery);
  const versionSkew = primaryBackend && candidateBackend
    ? evaluateVersionSkew(primaryBackend.version, candidateBackend.version)
    : { compatible: true, reasons: [] };
  const cacheActions = planCacheActions({
    expectedResources: snapshot.expectedResources,
    discovery: candidateDiscovery,
    backend: candidateBackend,
    cache: snapshot.cache,
    force: policy.force,
  });

  const gates = {
    endpoint: isEndpointHealthy(candidate),
    discovery: discoveryEvaluation.complete,
    version: versionSkew.compatible,
    resourceVersion: cacheActions.mode !== 'blocked',
  };
  gates.allPassed = Object.entries(gates)
    .filter(([name]) => name !== 'allPassed')
    .every(([, passed]) => passed);

  let blockedReason = REASON.NONE;
  if (!gates.endpoint) blockedReason = REASON.NO_HEALTHY_CANDIDATE;
  else if (!gates.discovery) blockedReason = REASON.PARTIAL_DISCOVERY;
  else if (!gates.version) blockedReason = REASON.VERSION_SKEW;
  else if (!gates.resourceVersion) blockedReason = REASON.RV_INCOMPATIBLE;

  return {
    candidate,
    candidateDiscovery,
    candidateBackend,
    discoveryEvaluation,
    versionSkew,
    cacheActions,
    gates,
    blockedReason,
  };
}

function buildRequestContext(snapshot, phase, activeEndpoint, backend, discoveryEvaluation, cacheActions) {
  return {
    phase,
    discoveryEvaluation,
    cache: snapshot.cache,
    backend,
    cacheActions,
  };
}

// 纯函数：输入一个完整快照，输出本 tick 的切换决策、缓存动作与请求处置。
export function evaluateFailover(rawSnapshot) {
  const snapshot = rawSnapshot;
  const policy = { ...DEFAULT_POLICY, ...(snapshot.policy ?? {}) };
  const controller = { ...createController(snapshot.endpoints[0]?.id), ...(snapshot.controller ?? {}) };
  const now = snapshot.now ?? 0;
  const events = [];

  const activeEndpoint = getEndpoint(snapshot, controller.activeEndpointId);
  const activeBackend = activeEndpoint ? getBackend(snapshot, activeEndpoint.id) : null;
  const activeDiscovery = activeEndpoint ? getDiscovery(snapshot, activeEndpoint.id) : null;
  const activeDiscoveryEvaluation = activeDiscovery
    ? evaluateDiscovery(snapshot.expectedResources, activeDiscovery)
    : evaluateDiscovery(snapshot.expectedResources, { complete: false, returnedResources: [] });

  const activeHealthy = activeEndpoint ? isEndpointHealthy(activeEndpoint) : false;
  const apiServiceAvailable = Boolean(snapshot.apiservice?.available);

  const candidate = selectCandidate(snapshot.endpoints, controller.activeEndpointId, policy.preferPrimary);
  const candidateEvaluation = candidate ? evaluateCandidate(snapshot, candidate, policy) : null;

  let phase = controller.phase;
  let blockedReason = REASON.NONE;
  let switchAllowed = false;
  let switchback = { requested: Boolean(snapshot.requestSwitchback), blocked: false, reason: REASON.NONE };

  function enter(nextPhase, event) {
    phase = nextPhase;
    if (event) events.push({ at: now, type: event, from: controller.phase, to: nextPhase });
  }

  switch (controller.phase) {
    case PHASE.STABLE: {
      if (snapshot.requestSwitchback && activeEndpoint?.role !== 'primary') {
        const primary = snapshot.endpoints.find((endpoint) => endpoint.role === 'primary');
        if (!primary || !isEndpointHealthy(primary)) {
          switchback.blocked = true;
          switchback.reason = REASON.NO_HEALTHY_CANDIDATE;
        } else if (now - controller.lastSwitchAt < policy.cooldownMs) {
          switchback.blocked = true;
          switchback.reason = REASON.SWITCHBACK_COOLDOWN;
        } else {
          const evaluation = evaluateCandidate(snapshot, primary, policy);
          if (evaluation.gates.allPassed) {
            controller.candidateEndpointId = primary.id;
            enter(PHASE.SUSPECT, 'switchback-requested');
          } else {
            switchback.blocked = true;
            switchback.reason = evaluation.blockedReason;
          }
        }
      } else if (!activeHealthy) {
        // APIService 的 Available 可能滞后于真实端点状态，因此以端点探针为准。
        enter(PHASE.SUSPECT, apiServiceAvailable ? 'active-lost-but-apiservice-still-available' : 'active-lost');
      }
      break;
    }

    case PHASE.SUSPECT: {
      if (!candidate || !isEndpointHealthy(candidate)) {
        blockedReason = REASON.NO_HEALTHY_CANDIDATE;
      } else {
        controller.candidateEndpointId = candidate.id;
        enter(PHASE.DRAIN, 'begin-drain');
      }
      break;
    }

    case PHASE.DRAIN: {
      if (!controller.drainMarked) {
        // 等待写入与 watch 排空完成（由模拟器/外部控制器标记）。
        break;
      }
      enter(PHASE.VERIFY, 'drain-complete');
      break;
    }

    case PHASE.VERIFY: {
      const verifyCandidate = getEndpoint(snapshot, controller.candidateEndpointId);
      if (!verifyCandidate || !isEndpointHealthy(verifyCandidate)) {
        controller.candidateEndpointId = null;
        enter(PHASE.SUSPECT, 'candidate-lost-during-verify');
        break;
      }
      const evaluation = evaluateCandidate(snapshot, verifyCandidate, policy);
      if (evaluation.gates.allPassed) {
        enter(PHASE.RESET, 'verify-passed');
      } else {
        blockedReason = evaluation.blockedReason;
      }
      break;
    }

    case PHASE.RESET: {
      if (!controller.cacheResetDone) {
        // 缓存刷新/失效动作由外部执行完成后标记 cacheResetDone。
        break;
      }
      controller.activeEndpointId = controller.candidateEndpointId;
      controller.candidateEndpointId = null;
      controller.lastSwitchAt = now;
      controller.failoverCount += 1;
      enter(PHASE.COOLDOWN, 'traffic-shifted');
      break;
    }

    case PHASE.COOLDOWN: {
      if (snapshot.requestSwitchback) {
        switchback.blocked = true;
        switchback.reason = REASON.SWITCHBACK_COOLDOWN;
      }
      if (now - controller.lastSwitchAt >= policy.cooldownMs) {
        enter(PHASE.STABLE, 'cooldown-elapsed');
      }
      break;
    }

    default:
      enter(PHASE.STABLE, 'unknown-phase-reset');
  }

  // 选择当前阶段对外暴露的评估对象：校验阶段看候选，服务阶段看 active。
  const inVerification = phase === PHASE.VERIFY || phase === PHASE.RESET;
  let exposedEvaluation;
  if (inVerification && controller.candidateEndpointId) {
    exposedEvaluation = evaluateCandidate(
      snapshot,
      getEndpoint(snapshot, controller.candidateEndpointId),
      policy,
    );
    blockedReason = exposedEvaluation.gates.allPassed
      ? REASON.NONE
      : exposedEvaluation.blockedReason;
    switchAllowed = exposedEvaluation.gates.allPassed;
  } else if (candidateEvaluation) {
    exposedEvaluation = candidateEvaluation;
    switchAllowed = candidateEvaluation.gates.allPassed && activeHealthy === false;
    if (phase === PHASE.SUSPECT && !candidateEvaluation.gates.endpoint) {
      blockedReason = REASON.NO_HEALTHY_CANDIDATE;
    }
  } else {
    exposedEvaluation = {
      candidate: null,
      discoveryEvaluation: activeDiscoveryEvaluation,
      versionSkew: { compatible: true, reasons: [] },
      cacheActions: { mode: 'none', relist: [], drop: [], incompatible: [], watches: [], summary: {} },
      gates: { endpoint: false, discovery: false, version: false, resourceVersion: false, allPassed: false },
      blockedReason: REASON.NO_HEALTHY_CANDIDATE,
    };
  }

  let requestDiscoveryEvaluation;
  let requestCacheActions;
  let servingBackend;
  if (inVerification) {
    requestDiscoveryEvaluation = exposedEvaluation.discoveryEvaluation;
    requestCacheActions = exposedEvaluation.cacheActions;
    servingBackend = exposedEvaluation.candidateBackend;
  } else {
    requestDiscoveryEvaluation = activeDiscoveryEvaluation;
    requestCacheActions = planCacheActions({
      expectedResources: snapshot.expectedResources,
      discovery: activeDiscovery,
      backend: activeBackend,
      cache: snapshot.cache,
      force: policy.force,
    });
    servingBackend = activeBackend;
  }
  const requestContext = buildRequestContext(
    snapshot,
    phase,
    activeEndpoint,
    servingBackend,
    requestDiscoveryEvaluation,
    requestCacheActions,
  );
  const rejections = evaluateRequests(snapshot.requests, requestContext);

  return {
    phase,
    previousPhase: controller.phase,
    controller: {
      ...controller,
      phase,
    },
    activeEndpointId: controller.activeEndpointId,
    candidateEndpointId: controller.candidateEndpointId,
    apiServiceAvailable,
    activeHealthy,
    events,
    gates: exposedEvaluation.gates,
    switchAllowed,
    blockedReason,
    switchback,
    discovery: exposedEvaluation.discoveryEvaluation,
    versionSkew: exposedEvaluation.versionSkew,
    cacheActions: exposedEvaluation.cacheActions,
    rejections,
  };
}

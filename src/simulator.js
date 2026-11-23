import { applyCacheActions } from './cache.js';
import { PHASE } from './constants.js';
import { createController, evaluateFailover } from './engine.js';
import { isEndpointHealthy } from './endpoints.js';

// 本地故障切换模拟器：用固定可控的虚拟时钟驱动状态机，全程不连接 Kubernetes。
export class FailoverSimulator {
  constructor(baseSnapshot) {
    this.snapshot = structuredClone(baseSnapshot);
    const initial = this.snapshot.endpoints.find(
      (endpoint) => endpoint.role === 'primary' && isEndpointHealthy(endpoint),
    ) ?? this.snapshot.endpoints[0];
    this.controller = createController(initial.id);
    this.snapshot.controller = this.controller;
    this.snapshot.now = this.snapshot.now ?? 0;
    this.history = [];
  }

  get activeId() {
    return this.controller.activeEndpointId;
  }

  get phase() {
    return this.controller.phase;
  }

  get cache() {
    return this.snapshot.cache;
  }

  advance(ms) {
    this.snapshot.now += ms;
    return this;
  }

  setNow(now) {
    this.snapshot.now = now;
    return this;
  }

  endpoint(id) {
    return this.snapshot.endpoints.find((item) => item.id === id);
  }

  backend(id) {
    return this.snapshot.backends[id];
  }

  failEndpoint(id) {
    const endpoint = this.endpoint(id);
    endpoint.ready = false;
    endpoint.serving = false;
    return this;
  }

  restoreEndpoint(id) {
    const endpoint = this.endpoint(id);
    endpoint.ready = true;
    endpoint.serving = true;
    return this;
  }

  setDiscovery(endpointId, discovery) {
    this.snapshot.discovery.perEndpoint[endpointId] = structuredClone(discovery);
    return this;
  }

  setResourceVersion(endpointId, resourceKeyName, resourceVersion) {
    this.snapshot.backends[endpointId].resourceVersions[resourceKeyName] = resourceVersion;
    return this;
  }

  setBackendVersion(endpointId, version) {
    this.snapshot.backends[endpointId].version = { ...version };
    return this;
  }

  requestSwitchback() {
    this.snapshot.requestSwitchback = true;
    return this;
  }

  cancelSwitchback() {
    this.snapshot.requestSwitchback = false;
    return this;
  }

  withRequests(requests) {
    this.snapshot.requests = structuredClone(requests);
    return this;
  }

  tick(mutate) {
    if (mutate) mutate(this.snapshot);
    this.snapshot.controller = this.controller;

    // 外部动作（排空完成、缓存刷新）在评估前落地，状态机本 tick 即可越过等待状态。
    if (this.controller.phase === PHASE.DRAIN && !this.controller.drainMarked) {
      this.controller.drainMarked = true;
    }
    if (this.controller.phase === PHASE.RESET && !this.controller.cacheResetDone) {
      const preDecision = evaluateFailover(this.snapshot);
      const candidateId = this.controller.candidateEndpointId;
      this.snapshot.cache = applyCacheActions(
        this.snapshot.cache,
        preDecision.cacheActions,
        this.snapshot.discovery.perEndpoint[candidateId],
        this.snapshot.backends[candidateId],
      );
      this.controller.cacheResetDone = true;
    }

    const decision = evaluateFailover(this.snapshot);
    const shifted = decision.events.some((event) => event.type === 'traffic-shifted');
    if (shifted) {
      this.controller.drainMarked = false;
      this.controller.cacheResetDone = false;
    }

    Object.assign(this.controller, decision.controller);
    // 被阻塞的回切请求保留，便于下一个 tick（如冷却结束后）再次评估；已进入流程则清除。
    if (!decision.switchback.blocked) {
      this.snapshot.requestSwitchback = false;
    }
    this.snapshot.requests = [];
    this.history.push({
      now: this.snapshot.now,
      phase: decision.phase,
      active: decision.activeEndpointId,
      candidate: decision.candidateEndpointId,
      blockedReason: decision.blockedReason,
      switchAllowed: decision.switchAllowed,
    });
    return decision;
  }

  // 连续 tick 直到进入目标阶段或超过最大步数。
  runUntil(targetPhase, maxTicks = 20, mutate) {
    let last = null;
    for (let index = 0; index < maxTicks; index += 1) {
      last = this.tick(mutate);
      if (last.phase === targetPhase) return last;
    }
    return last;
  }
}

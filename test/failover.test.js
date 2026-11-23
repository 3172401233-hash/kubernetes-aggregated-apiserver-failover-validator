import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DECISION, PHASE } from '../src/constants.js';
import { FailoverSimulator } from '../src/simulator.js';
import { baseSnapshot, sampleRequests, POD_KEY, NODE_KEY } from './fixtures.js';

describe('主后端失联后的主备切换', () => {
  it('APIService 仍 Available 时，端点探针仍触发 SUSPECT', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    const stable = simulator.tick();
    assert.equal(stable.phase, PHASE.STABLE);
    assert.equal(stable.activeEndpointId, 'primary');

    simulator.failEndpoint('primary');
    const suspect = simulator.tick();
    assert.equal(suspect.phase, PHASE.SUSPECT);
    assert.equal(suspect.apiServiceAvailable, true);
    assert.equal(suspect.activeHealthy, false);
    assert.equal(suspect.events[0].type, 'active-lost-but-apiservice-still-available');
  });

  it('完整推进 SUSPECT -> DRAIN -> VERIFY -> RESET -> COOLDOWN -> STABLE', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');

    assert.equal(simulator.tick().phase, PHASE.SUSPECT);
    const drain = simulator.tick();
    assert.equal(drain.phase, PHASE.DRAIN);
    assert.equal(drain.controller.drainMarked, false);

    const verify = simulator.tick();
    assert.equal(verify.phase, PHASE.VERIFY);
    assert.equal(simulator.controller.drainMarked, true);
    assert.equal(verify.gates.allPassed, true);
    assert.equal(verify.candidateEndpointId, 'standby');

    const reset = simulator.tick();
    assert.equal(reset.phase, PHASE.RESET);
    assert.equal(reset.switchAllowed, true);

    const cooldown = simulator.tick();
    assert.equal(cooldown.phase, PHASE.COOLDOWN);
    assert.equal(cooldown.activeEndpointId, 'standby');
    assert.equal(cooldown.controller.failoverCount, 1);

    simulator.advance(30_000);
    const stable = simulator.tick();
    assert.equal(stable.phase, PHASE.STABLE);
    assert.equal(stable.activeEndpointId, 'standby');
  });

  it('兼容且更新的 resourceVersion 触发定向 relist，watch 可续传', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    const reset = simulator.runUntil(PHASE.RESET);

    const relistKeys = reset.cacheActions.relist.map((item) => item.resourceKey).sort();
    assert.deepEqual(relistKeys, [NODE_KEY, POD_KEY]);
    assert.equal(reset.cacheActions.mode, 'targeted');
    assert.deepEqual(
      reset.cacheActions.watches.map((watch) => watch.action),
      ['resume'],
    );

    simulator.tick();
    const podEntry = simulator.cache.resources.find((entry) => entry.resourceKey === POD_KEY);
    const nodeEntry = simulator.cache.resources.find((entry) => entry.resourceKey === NODE_KEY);
    assert.equal(podEntry.resourceVersion, '105');
    assert.equal(nodeEntry.resourceVersion, '52');
    assert.equal(podEntry.syncedFrom, 'standby');
  });

  it('切换窗口内变更与 watch 被拒绝，读请求也被挂起', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.withRequests(sampleRequests());
    const drain = simulator.tick();

    const byId = new Map(drain.rejections.map((item) => [item.request.id, item]));
    assert.equal(byId.get('create-pipeline').decision, DECISION.RETRY_503);
    assert.equal(byId.get('watch-pods').decision, DECISION.RETRY_503);
    assert.equal(byId.get('list-pods').decision, DECISION.RETRY_503);
  });

  it('没有健康备后端时停留在 SUSPECT 并给出阻塞原因', () => {
    const snapshot = baseSnapshot();
    snapshot.endpoints[1].ready = false;
    snapshot.endpoints[1].serving = false;
    const simulator = new FailoverSimulator(snapshot);
    simulator.failEndpoint('primary');

    simulator.tick();
    const stuck = simulator.tick();
    assert.equal(stuck.phase, PHASE.SUSPECT);
    assert.equal(stuck.blockedReason, 'NO_HEALTHY_CANDIDATE');
    assert.equal(stuck.switchAllowed, false);
  });
});

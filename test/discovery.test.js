import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DECISION, PHASE, REASON } from '../src/constants.js';
import { evaluateFailover } from '../src/engine.js';
import { FailoverSimulator } from '../src/simulator.js';
import {
  baseSnapshot,
  partialDiscovery,
  truncatedDiscovery,
  CUSTOM_PIPELINE,
  METRICS_POD,
  PIPELINE_KEY,
  POD_KEY,
} from './fixtures.js';

describe('部分 discovery 不等于可用', () => {
  it('备后端缺少 custom metrics 时，VERIFY 被 PARTIAL_DISCOVERY 阻塞', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.setDiscovery('standby', partialDiscovery());

    simulator.runUntil(PHASE.VERIFY);
    const verify = simulator.tick();
    assert.equal(verify.phase, PHASE.VERIFY);
    assert.equal(verify.gates.discovery, false);
    assert.equal(verify.gates.allPassed, false);
    assert.equal(verify.blockedReason, REASON.PARTIAL_DISCOVERY);
    assert.equal(verify.switchAllowed, false);
    assert.deepEqual(
      verify.discovery.missingResources.map((resource) => resource.plural),
      ['pipelines'],
    );
  });

  it('discovery 补齐后解除阻塞并继续切换', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.setDiscovery('standby', partialDiscovery());
    simulator.runUntil(PHASE.VERIFY);

    const blocked = simulator.tick();
    assert.equal(blocked.phase, PHASE.VERIFY);

    simulator.setDiscovery('standby', baseSnapshot().discovery.perEndpoint.standby);
    const reset = simulator.tick();
    assert.equal(reset.phase, PHASE.RESET);
    assert.equal(reset.gates.discovery, true);
  });

  it('缺失资源的缓存条目被标记 DROP，且不对外返回陈旧对象', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.setDiscovery('standby', partialDiscovery());
    simulator.runUntil(PHASE.VERIFY);
    const verify = simulator.tick();

    assert.deepEqual(
      verify.cacheActions.drop.map((item) => item.resourceKey),
      [PIPELINE_KEY],
    );

    simulator.withRequests([
      { id: 'get-pipeline', verb: 'get', ...CUSTOM_PIPELINE },
      { id: 'watch-pipeline', verb: 'watch', ...CUSTOM_PIPELINE },
      { id: 'get-pod', verb: 'get', ...METRICS_POD },
    ]);
    const evaluated = simulator.tick();
    const byId = new Map(evaluated.rejections.map((item) => [item.request.id, item]));
    assert.equal(byId.get('get-pipeline').decision, DECISION.RETRY_503);
    assert.equal(byId.get('watch-pipeline').decision, DECISION.RETRY_503);
    assert.equal(byId.get('get-pod').decision, DECISION.RETRY_503);
  });

  it('截断的资源列表要求重新 relist', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.setDiscovery('standby', truncatedDiscovery());
    const reset = simulator.runUntil(PHASE.RESET);

    const truncated = reset.cacheActions.relist.find((item) => item.resourceKey === POD_KEY);
    assert.ok(truncated);
    assert.equal(truncated.reason, 'truncated-list');
  });

  it('STABLE 阶段 active discovery 缺资源时，读返回 404、watch 返回 503', () => {
    const snapshot = baseSnapshot();
    snapshot.discovery.perEndpoint.primary = partialDiscovery();
    snapshot.requests = [
      { id: 'get-pipeline', verb: 'get', ...CUSTOM_PIPELINE },
      { id: 'watch-pipeline', verb: 'watch', ...CUSTOM_PIPELINE },
    ];
    const decision = evaluateFailover(snapshot);
    assert.equal(decision.phase, PHASE.STABLE);

    const byId = new Map(decision.rejections.map((item) => [item.request.id, item]));
    assert.equal(byId.get('get-pipeline').decision, DECISION.NOT_FOUND_404);
    assert.equal(byId.get('watch-pipeline').decision, DECISION.RETRY_503);
  });
});

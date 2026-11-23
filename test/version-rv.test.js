import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PHASE, REASON, DECISION } from '../src/constants.js';
import { compareResourceVersion, RV_STATUS } from '../src/rv.js';
import { FailoverSimulator } from '../src/simulator.js';
import { baseSnapshot, METRICS_POD, POD_KEY } from './fixtures.js';

describe('resourceVersion 比较原语', () => {
  it('识别相等、更新、回退与不透明 RV', () => {
    assert.equal(compareResourceVersion('105', '100'), RV_STATUS.NEWER);
    assert.equal(compareResourceVersion('100', '100'), RV_STATUS.EQUAL);
    assert.equal(compareResourceVersion('99', '100'), RV_STATUS.REGRESSED);
    assert.equal(compareResourceVersion('abc', '100'), RV_STATUS.INCOMPATIBLE);
    assert.equal(compareResourceVersion('105', 'opaque'), RV_STATUS.INCOMPATIBLE);
  });
});

describe('版本偏差', () => {
  it('minor 相差 1 仍然兼容', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.setBackendVersion('standby', { major: 1, minor: 32 });
    simulator.failEndpoint('primary');
    const verify = simulator.runUntil(PHASE.VERIFY);
    assert.equal(verify.gates.version, true);
  });

  it('minor 相差 2 被 VERSION_SKEW 阻塞', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.setBackendVersion('standby', { major: 1, minor: 33 });
    simulator.failEndpoint('primary');
    simulator.runUntil(PHASE.SUSPECT);
    simulator.tick();
    const verify = simulator.tick();
    assert.equal(verify.phase, PHASE.VERIFY);
    assert.equal(verify.gates.version, false);
    assert.equal(verify.blockedReason, REASON.VERSION_SKEW);
  });

  it('major 不一致被 VERSION_SKEW 阻塞', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.setBackendVersion('standby', { major: 2, minor: 31 });
    simulator.failEndpoint('primary');
    simulator.runUntil(PHASE.SUSPECT);
    simulator.tick();
    const verify = simulator.tick();
    assert.equal(verify.blockedReason, REASON.VERSION_SKEW);
  });
});

describe('resourceVersion 不兼容', () => {
  it('备后端 RV 回退时被 RV_INCOMPATIBLE 阻塞', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.setResourceVersion('standby', POD_KEY, '90');
    simulator.failEndpoint('primary');
    const verify = simulator.runUntil(PHASE.VERIFY);

    assert.equal(verify.gates.resourceVersion, false);
    assert.equal(verify.blockedReason, REASON.RV_INCOMPATIBLE);
    assert.deepEqual(
      verify.cacheActions.incompatible.map((item) => item.resourceKey),
      [POD_KEY],
    );
  });

  it('不透明 RV 视为不兼容', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.setResourceVersion('standby', POD_KEY, 'opaque:abc');
    simulator.failEndpoint('primary');
    const verify = simulator.runUntil(PHASE.VERIFY);
    assert.equal(verify.blockedReason, REASON.RV_INCOMPATIBLE);
  });

  it('强制切换时全量失效缓存并重启 watch，之后携带旧 RV 的请求得到 410', () => {
    const snapshot = baseSnapshot();
    snapshot.policy.force = true;
    const simulator = new FailoverSimulator(snapshot);
    simulator.setResourceVersion('standby', POD_KEY, '90');
    simulator.failEndpoint('primary');
    const reset = simulator.runUntil(PHASE.RESET);

    assert.equal(reset.cacheActions.mode, 'invalidate_all');
    assert.equal(reset.cacheActions.summary.invalidateAll, 1);
    assert.equal(simulator.tick().phase, PHASE.COOLDOWN);
    assert.deepEqual(simulator.cache.resources, []);
    assert.equal(simulator.cache.watches[0].active, false);

    // 全量失效后按新后端重新 list 回填缓存（RV 90），客户端仍拿着旧后端的 RV 100，必须 410。
    simulator.cache.resources = [
      { resourceKey: POD_KEY, resourceVersion: '90', syncedFrom: 'standby', fullyListed: true },
    ];
    simulator.withRequests([
      { id: 'stale-watch', verb: 'watch', ...METRICS_POD, resourceVersion: '100' },
    ]);
    const serving = simulator.tick();
    const result = serving.rejections.find((item) => item.request.id === 'stale-watch');
    assert.equal(result.decision, DECISION.GONE_410);
    assert.equal(result.latestResourceVersion, '90');
  });
});

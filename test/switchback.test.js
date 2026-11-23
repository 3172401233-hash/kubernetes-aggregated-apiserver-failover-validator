import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PHASE, REASON } from '../src/constants.js';
import { FailoverSimulator } from '../src/simulator.js';
import { baseSnapshot } from './fixtures.js';

describe('快速回切抑制', () => {
  it('冷却期内请求回切被 SWITCHBACK_COOLDOWN 拒绝', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.runUntil(PHASE.COOLDOWN);
    assert.equal(simulator.activeId, 'standby');

    simulator.restoreEndpoint('primary');
    simulator.requestSwitchback();
    const rejected = simulator.tick();
    assert.equal(rejected.phase, PHASE.COOLDOWN);
    assert.equal(rejected.switchback.blocked, true);
    assert.equal(rejected.switchback.reason, REASON.SWITCHBACK_COOLDOWN);
    assert.equal(simulator.activeId, 'standby');
  });

  it('冷却结束后允许回切到主，并再次走完整切换流程', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.runUntil(PHASE.COOLDOWN);
    simulator.restoreEndpoint('primary');

    simulator.advance(30_000);
    const stable = simulator.tick();
    assert.equal(stable.phase, PHASE.STABLE);

    // 缓存先重新拉齐，再显式发起回切。
    simulator.cache.resources = baseSnapshot().cache.resources;
    simulator.requestSwitchback();
    const suspect = simulator.tick();
    assert.equal(suspect.phase, PHASE.SUSPECT);
    assert.equal(suspect.events[0].type, 'switchback-requested');

    const cooldown = simulator.runUntil(PHASE.COOLDOWN);
    assert.equal(cooldown.activeEndpointId, 'primary');
    assert.equal(cooldown.controller.failoverCount, 2);
  });

  it('冷却期内主再次失联时不能回切', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.runUntil(PHASE.COOLDOWN);
    simulator.requestSwitchback();
    const decision = simulator.tick();
    assert.equal(decision.switchback.blocked, true);
    assert.equal(decision.switchback.reason, REASON.SWITCHBACK_COOLDOWN);
  });

  it('冷却结束但主仍不健康时，回切以 NO_HEALTHY_CANDIDATE 被拒', () => {
    const simulator = new FailoverSimulator(baseSnapshot());
    simulator.failEndpoint('primary');
    simulator.runUntil(PHASE.COOLDOWN);
    simulator.advance(30_000);
    simulator.tick();

    simulator.requestSwitchback();
    const decision = simulator.tick();
    assert.equal(decision.phase, PHASE.STABLE);
    assert.equal(decision.switchback.blocked, true);
    assert.equal(decision.switchback.reason, REASON.NO_HEALTHY_CANDIDATE);
  });
});

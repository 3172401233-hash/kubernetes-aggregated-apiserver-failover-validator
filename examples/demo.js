import { DECISION, PHASE } from '../src/constants.js';
import { evaluateFailover } from '../src/engine.js';
import { FailoverSimulator } from '../src/simulator.js';
import {
  baseSnapshot,
  CUSTOM_PIPELINE,
  METRICS_POD,
  partialDiscovery,
  PIPELINE_KEY,
  sampleRequests,
} from '../test/fixtures.js';

function line(title) {
  console.log(`\n=== ${title} ===`);
}

function printDecision(label, decision) {
  console.log(
    `[${label}] phase=${decision.phase} active=${decision.activeEndpointId} `
      + `candidate=${decision.candidateEndpointId ?? '-'} blocked=${decision.blockedReason}`,
  );
}

line('场景 1：主后端失联，完整故障切换（APIService 仍误报 Available）');
{
  const simulator = new FailoverSimulator(baseSnapshot());
  simulator.failEndpoint('primary');
  simulator.withRequests(sampleRequests());

  for (let tick = 0; tick < 6; tick += 1) {
    const decision = simulator.tick();
    printDecision(`tick ${tick}`, decision);
    if (decision.phase === PHASE.RESET) {
      console.log('  缓存动作:', JSON.stringify(decision.cacheActions.summary));
      console.log('  relist:', decision.cacheActions.relist.map((item) => item.resourceKey).join(', '));
    }
    if (decision.rejections.length > 0) {
      for (const rejection of decision.rejections) {
        console.log(`  请求 ${rejection.request.id} -> ${rejection.decision} (${rejection.reason})`);
      }
    }
  }
}

line('场景 2：备后端只有部分 discovery，切换必须被阻塞');
{
  const simulator = new FailoverSimulator(baseSnapshot());
  simulator.failEndpoint('primary');
  simulator.setDiscovery('standby', partialDiscovery());
  simulator.runUntil(PHASE.VERIFY);
  const blocked = simulator.tick();
  printDecision('partial', blocked);
  console.log('  缺失资源:', blocked.discovery.missingResources.map((resource) => resource.plural).join(', '));
  console.log('  待丢弃缓存:', blocked.cacheActions.drop.map((item) => item.resourceKey).join(', '));
}

line('场景 3：服务期内对缺失资源的请求处置（404 vs 503）');
{
  const snapshot = baseSnapshot();
  snapshot.discovery.perEndpoint.primary = partialDiscovery();
  snapshot.requests = [
    { id: 'get-pipeline', verb: 'get', ...CUSTOM_PIPELINE },
    { id: 'watch-pipeline', verb: 'watch', ...CUSTOM_PIPELINE },
    { id: 'list-pods', verb: 'list', ...METRICS_POD },
  ];
  const decision = evaluateFailover(snapshot);
  for (const rejection of decision.rejections) {
    const verdict = rejection.decision === DECISION.PROCEED ? '放行' : rejection.decision;
    console.log(`  请求 ${rejection.request.id} -> ${verdict} (${rejection.reason})`);
  }
  console.log(`  注意：${PIPELINE_KEY} 的缓存不会被静默保留为可用资源`);
}

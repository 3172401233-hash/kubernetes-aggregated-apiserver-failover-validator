import { resourceKey } from '../src/rv.js';

export const METRICS_POD = Object.freeze({ group: 'metrics.k8s.io', version: 'v1beta1', plural: 'pods' });
export const METRICS_NODE = Object.freeze({ group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes' });
export const CUSTOM_PIPELINE = Object.freeze({ group: 'custom.metrics.example.io', version: 'v1', plural: 'pipelines' });

export const POD_KEY = resourceKey(METRICS_POD.group, METRICS_POD.version, METRICS_POD.plural);
export const NODE_KEY = resourceKey(METRICS_NODE.group, METRICS_NODE.version, METRICS_NODE.plural);
export const PIPELINE_KEY = resourceKey(CUSTOM_PIPELINE.group, CUSTOM_PIPELINE.version, CUSTOM_PIPELINE.plural);

export const EXPECTED_RESOURCES = Object.freeze([METRICS_POD, METRICS_NODE, CUSTOM_PIPELINE]);

function fullDiscovery() {
  return {
    complete: true,
    returnedResources: [
      { ...METRICS_POD },
      { ...METRICS_NODE },
      { ...CUSTOM_PIPELINE },
    ],
  };
}

// 备后端只返回两个资源、缺 custom metrics，典型的“部分 discovery 成功”。
export function partialDiscovery() {
  return {
    complete: false,
    returnedResources: [{ ...METRICS_POD }, { ...METRICS_NODE }],
  };
}

export function truncatedDiscovery() {
  return {
    complete: true,
    returnedResources: [
      { ...METRICS_POD, truncated: true },
      { ...METRICS_NODE },
      { ...CUSTOM_PIPELINE },
    ],
  };
}

function backends() {
  return {
    primary: {
      id: 'primary',
      role: 'primary',
      version: { major: 1, minor: 31 },
      resourceVersions: {
        [POD_KEY]: '100',
        [NODE_KEY]: '50',
        [PIPELINE_KEY]: '20',
      },
    },
    standby: {
      id: 'standby',
      role: 'standby',
      version: { major: 1, minor: 31 },
      resourceVersions: {
        [POD_KEY]: '105',
        [NODE_KEY]: '52',
        [PIPELINE_KEY]: '20',
      },
    },
  };
}

function endpoints() {
  return [
    { id: 'primary', role: 'primary', ready: true, serving: true, priority: 10 },
    { id: 'standby', role: 'standby', ready: true, serving: true, priority: 20 },
  ];
}

function discoveryPerEndpoint() {
  return {
    primary: fullDiscovery(),
    standby: fullDiscovery(),
  };
}

export function baseCache() {
  return {
    resources: [
      { resourceKey: POD_KEY, resourceVersion: '100', syncedFrom: 'primary', fullyListed: true },
      { resourceKey: NODE_KEY, resourceVersion: '50', syncedFrom: 'primary', fullyListed: true },
      { resourceKey: PIPELINE_KEY, resourceVersion: '20', syncedFrom: 'primary', fullyListed: true },
    ],
    watches: [
      { id: 'watch-pods', resourceKey: POD_KEY, resourceVersion: '100', active: true },
    ],
  };
}

export function baseSnapshot(overrides = {}) {
  return {
    now: 0,
    policy: { cooldownMs: 30_000, preferPrimary: true, force: false },
    apiservice: {
      name: 'v1beta1.metrics.k8s.io',
      available: true,
      conditions: [
        { type: 'Available', status: 'True' },
        { type: 'StatusConditionNotFound', status: 'False' },
      ],
    },
    endpoints: endpoints(),
    backends: backends(),
    discovery: {
      aggregated: { complete: true, resourceCount: 3 },
      perEndpoint: discoveryPerEndpoint(),
    },
    expectedResources: EXPECTED_RESOURCES.map((item) => ({ ...item })),
    cache: baseCache(),
    requests: [],
    ...overrides,
  };
}

export function sampleRequests() {
  return [
    { id: 'list-pods', verb: 'list', ...METRICS_POD },
    { id: 'create-pipeline', verb: 'create', ...CUSTOM_PIPELINE },
    { id: 'watch-pods', verb: 'watch', ...METRICS_POD, resourceVersion: '100' },
    { id: 'stale-list', verb: 'list', ...METRICS_NODE, resourceVersion: '40' },
  ];
}

// 切换状态机的各个阶段。
// 整个模型是本地纯函数推导，不调用任何 Kubernetes 接口。
export const PHASE = Object.freeze({
  // 服务端整体可达，由当前 active 后端正常提供服务。
  STABLE: 'STABLE',
  // APIService 仍宣称 Available，但探针已发现 active 后端异常，需要进一步确认。
  SUSPECT: 'SUSPECT',
  // 已确认 active 不可用，开始排空写入/长连接，停止切换窗口内的变更。
  DRAIN: 'DRAIN',
  // 对候选备后端做端点、discovery、版本与 resourceVersion 校验。
  VERIFY: 'VERIFY',
  // 校验通过，按 resourceVersion 兼容性刷新/失效客户端缓存。
  RESET: 'RESET',
  // 已切到新后端，处于快速回切抑制冷却期。
  COOLDOWN: 'COOLDOWN',
});

export const ALL_PHASES = Object.freeze(Object.values(PHASE));

// 判定不可切换的阻塞原因。
export const REASON = Object.freeze({
  NONE: 'NONE',
  NO_HEALTHY_CANDIDATE: 'NO_HEALTHY_CANDIDATE',
  PARTIAL_DISCOVERY: 'PARTIAL_DISCOVERY',
  VERSION_SKEW: 'VERSION_SKEW',
  RV_INCOMPATIBLE: 'RV_INCOMPATIBLE',
  SWITCHBACK_COOLDOWN: 'SWITCHBACK_COOLDOWN',
});

// 缓存动作类型。
export const CACHE_ACTION = Object.freeze({
  // 缓存仍可信，无需处理。
  KEEP: 'KEEP',
  // 新后端 resourceVersion 兼容且更新，对该资源 relist 刷新。
  RELIST: 'RELIST',
  // 新后端缺该 discovery 项，必须丢弃缓存（资源看似“消失”的根源要被显式处理）。
  DROP: 'DROP',
  // resourceVersion 不兼容，整个缓存必须整体失效。
  INVALIDATE_ALL: 'INVALIDATE_ALL',
});

// 请求处置结果。
export const DECISION = Object.freeze({
  // 允许透传到 active 后端。
  PROCEED: 'PROCEED',
  // 切换窗口 / 发现不完整 / 版本不兼容，拒绝并要求稍后重试。
  RETRY_503: 'RETRY_503',
  // 缓存中已被 discovery 判定缺失的资源，不再返回陈旧对象。
  NOT_FOUND_404: 'NOT_FOUND_404',
  // 请求携带的 resourceVersion 已落后于新后端，watch/list 必须重新开始。
  GONE_410: 'GONE_410',
});

// 阻塞期间请求的 Retry-After（毫秒，仅用于模型演示）。
export const RETRY_AFTER_MS = 1000;

# 聚合 API Server 故障切换验证器

验证聚合 API Server（如 metrics/custom metrics APIService）在主后端失联时的故障切换判定，
解决“APIService 仍显示 Available、discovery 只返回部分结果、客户端缓存里的资源凭空消失”这一类问题。

## 重要说明：不连接 Kubernetes

本项目是一个**纯本地、零依赖的判定模型**，只使用 Node.js 内置模块（`node:test` 等）。

- 不会连接任何 Kubernetes 集群、apiserver、aggregation layer 或网络端点。
- APIService 状态、端点健康、后端版本、discovery 文档、资源列表、客户端缓存都以**快照对象**作为输入。
- 所有“切换 / 失效 / 拒绝”结论都是对输入快照做纯函数推导得到，可用虚拟时钟确定性复现。
- 运行环境：Node.js `v24.16.0`（`package.json` 中声明 `engines >=24.16.0`）。

## 背景问题

聚合 API 的真实可用性依赖后端链路，但控制器上报的 `APIService Available` 可能滞后：

1. 主后端已经失联，APIService 条件仍为 `Available=True`。
2. 备后端的 discovery 只成功了一部分（部分 GroupVersion/资源缺失），资源列表因此是“部分结果”。
3. 客户端 informer/watch 缓存基于旧列表，切换后出现资源“消失”或 resourceVersion 不连续。

本验证器把上述现象建模成可测试的规则，而不是依赖集群实时行为。

## 切换阶段（状态机）

阶段定义见 `src/constants.js`，状态机见 `src/engine.js`：

| 阶段 | 含义 | 客户端影响 |
| --- | --- | --- |
| `STABLE` | active 后端健康，正常服务 | 正常放行；active discovery 缺资源时读 404、watch 503 |
| `SUSPECT` | 端点探针发现 active 失联，即使 APIService 仍 Available 也进入 | 全部请求挂起（503） |
| `DRAIN` | 排空写入与 watch，冻结切换窗口内变更 | 写 / watch / 读一律 503，避免双写脑裂 |
| `VERIFY` | 对候选备后端做四项校验 | 校验不过则停留并给出阻塞原因 |
| `RESET` | 按 resourceVersion 兼容性刷新或失效缓存 | 缓存未对齐前不对外服务 |
| `COOLDOWN` | 流量已切到新后端，抑制快速回切 | 冷却期内回切请求被拒绝 |

### VERIFY 的四道判定门（全部通过才允许切换）

1. **端点门**：候选端点 `ready && serving`。
2. **discovery 门**：候选必须返回期望集合中的**每一个**资源。部分 discovery 成功不等于可用。
3. **版本门**：主备后端 major 相同、minor 偏差不超过 1（`src/endpoints.js`）。
4. **resourceVersion 门**：新后端 RV 与客户端缓存兼容，不允许新旧后端同时返回不兼容的 RV。

阻塞原因枚举：`NO_HEALTHY_CANDIDATE`、`PARTIAL_DISCOVERY`、`VERSION_SKEW`、`RV_INCOMPATIBLE`、
`SWITCHBACK_COOLDOWN`。

## resourceVersion 与缓存失效规则

实现在 `src/rv.js` 与 `src/cache.js`：

- 数字型 RV 按 `BigInt` 比较；非数字（不透明）RV 无法跨后端比较，一律判为不兼容。
- 候选 RV **相等或更新**：缓存可信，更新的资源做定向 `RELIST`，watch 可携带旧 RV 续传。
- 候选 RV **回退**或**不透明**：判定 `RV_INCOMPATIBLE`，默认阻塞切换。
- 显式 `force` 强制切换时，缓存必须 `INVALIDATE_ALL`、所有 watch 重启，不能做无缝续传。
- discovery 中缺失的资源，其缓存条目标记 `DROP`，绝不继续当作可用资源返回。
- discovery 报告列表被截断（truncated）时，对应资源必须重新 relist。
- 请求携带的 RV 与当前后端不连续时返回 `GONE_410`，要求从最新 RV 重新 list/watch。

## 请求处置

实现在 `src/requests.js`，输出四类结论：

- `PROCEED`：透传到 active 后端。
- `RETRY_503`：切换窗口、discovery 不完整、缓存失效后尚未回填，附带 `Retry-After`。
- `NOT_FOUND_404`：资源在 discovery 中缺失，不返回陈旧缓存对象。
- `GONE_410`：resourceVersion 落后或不兼容，客户端必须重新开始 list/watch。

## 目录结构

```
index.js                 统一导出
src/
  constants.js           阶段、阻塞原因、缓存动作、请求处置枚举
  rv.js                  resourceVersion 解析与兼容性比较
  endpoints.js           端点健康、版本偏差、discovery 完整性、候选选择
  cache.js               缓存刷新/失效计划与落地（纯函数）
  requests.js            单请求放行/拒绝判定
  engine.js              故障切换状态机（核心纯函数）
  simulator.js           虚拟时钟驱动的本地模拟器
examples/demo.js         可运行的场景演示
test/                    node:test 测试与夹具
```

## 运行

```bash
node --test          # 运行全部测试（也可用 npm test）
node examples/demo.js # 打印各场景的阶段、缓存动作与请求处置
```

## 测试覆盖

| 文件 | 覆盖场景 |
| --- | --- |
| `test/failover.test.js` | APIService 假 Available、完整主备切换、定向 relist、切换窗口拒绝、无健康候选 |
| `test/discovery.test.js` | 部分 discovery 阻塞、补齐后解除、缓存 DROP、截断列表、服务期 404/503 |
| `test/version-rv.test.js` | 版本偏差、RV 回退/不透明、强制切换全量失效、410 续传失败 |
| `test/switchback.test.js` | 冷却期快速回切拒绝、冷却后正常回切、主不健康时拒绝回切 |

## 模型边界

- 这是切换决策的**规则验证器**，不模拟真实 HTTP、watch 长连接或 etcd 语义。
- resourceVersion 采用“数字可比较、不透明即不兼容”的保守模型，刻意偏向安全而非乐观放行。
- 所有时间来自输入快照的 `now` 字段与模拟器虚拟时钟，测试结果完全确定、可重复。

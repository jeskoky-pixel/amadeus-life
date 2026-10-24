# 安装与配置（0.1.0 开发版）

验证环境：官方 DSH Desktop 0.2.1-rc.3、Node 22.23.2；包声明 Node >=22.13.0，依赖 node:sqlite，无第三方运行依赖。只有上述 DSH 版本经过本轮集成验证。

本轮已安装到独立的 Amadeus Life Development 工作空间对应开发配置，不需要修改生产 DSH。

## 安装

先克隆本仓库。由管理员使用该**开发配置**的正式 Plugin Manager 安装克隆目录。后台接口的实际语义如下（为宿主 API，不是 shell 命令）：

```js
pluginManager.installBundle(absoluteClonePath, { enabled: true })
pluginManager.setBundleEnabled('@amadeus/life', false) // 禁用并清理运行资源
pluginManager.setBundleEnabled('@amadeus/life', true)  // 重新加载，恢复持久状态
pluginManager.removeBundle('@amadeus/life')           // 卸载插件；保留数据供显式管理
```

以上四种操作均在隔离真实 Desktop 测试过。检查结果中的 application 和错误；pnpm exit 0 不等于激活成功。安装需要经过认证的管理员连接；普通 Workspace Write Agent 不因此获得配置管理或 Full Access。Desktop profile 由 Electron 管理，不要套用 CLI 修改生产 desktop profile。

本轮用本地 link 安装源码；没有 npm release。更新源码后应先运行测试，再通过开发配置的管理器按其返回结果重新加载或重启。普通用户配置可直接用离线生成器：`node scripts/life-setup.mjs --preset core|autonomous|activity`（只输出 JSON，不改 profile）。

## 配置

默认 bundle 插入 id=amadeus-life、name=@amadeus/life。可在开发配置中按官方 patch 语法覆盖：

```yaml
- id: amadeus-life
  config:
    databasePath: C:/amadeus-dev-data/life.sqlite
    tickIntervalMs: 1000
    maxReviewBatch: 20
    wakeDelivery:
      enabled: true
      allowedSessionIds: [session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]
    bootstrap:
      enabled: true
      personaName: Amadeus
```

databasePath 默认是当前 DSH_HOME/amadeus-life/life.sqlite。配置必须由可信管理员决定，模型工具不接受数据库路径。tickIntervalMs 可为 0（手动 tick）；每次最多检查 maxReviewBatch 项。停用时清理定时器、lease 与连接；卸载不会删除数据库。

普通用户先看单屏 [SETUP](SETUP.md)：三种预设、Session allowlist 说明、首次 bootstrap、admin 自定义绑定与健康错误。`bootstrap` 默认关闭；它会在 Life 行启用时创建稳定默认 Persona、每 Session 一个 private Scene 与 binding，同配置重复加载幂等，已有不同 binding 时 fail closed。下面的完整配置只给需要精细控制的 Advanced 管理员。

当前 schema v9。损坏、不兼容版本或缺少必要表会明确失败，不自动删除或换成空库。恢复前先备份，再人工检查；不要为消除报错盲删数据库。v2–v8 会按既有增量路径迁移；迁移前先冷备份 SQLite/WAL/SHM。

## 公共服务与事件

可信宿主使用 ctx.life 的 createIntent/getIntent/listIntents/updateIntent/cancelIntent、recordActivity/getActivity/listActivities/transitionActivity/requestCancelActivity、tickNow/listOutbox/acknowledgeEvent/getHealth。具体参数与错误见 src/core.js 的 JSDoc；scope 必须来自可信调用上下文。

```js
const intent = ctx.life.createIntent({
  description: '稍后重新考虑这篇文章',
  reviewAt: '2099-01-01T00:00:00.000Z',
  contextScope: trustedScope,
  authorizationRef: trustedAuthorizationRef,
})
ctx.life.updateIntent(intent.id, {
  scope: trustedScope, expectedRevision: intent.revision,
  reviewAt: '2099-01-02T00:00:00.000Z',
})
```

模型工具的 scope 由 exec.agent.session.id 推导；传 scope / trustedEvidence 等保留字段会被拒绝。可信 provider API 的 trustedEvidence 标记只供经过验证的宿主适配边界调用，不能作为公共模型参数。本版没有真实外发 provider。

life/reconsideration 是本地、引用形式的复查事件。消费者必须根据 scope、意图当前 revision 和当前授权读取与行动；本地事件或 acknowledge 不等于任何外部动作完成。现有 QQ ↔ Life v0.1 文档仍是未来适配草案，不能把本地事件直接冒充已实现的跨插件总线。

## 复跑

```text
npm test
node --test test/life-core.test.js test/revision.test.js
```

无需 npm install 即可运行核心测试。真实 DSH 集成证据及未验证范围见 verification/REPORT.md。

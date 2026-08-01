# TaskPilot Notion 同步优化方案

> 版本：v0.1（方案草案）  
> 日期：2026-08-01  
> 适用分支：`dev`  
> 状态：仅方案设计，未修改 Notion 同步业务代码，未提交或推送 GitHub

## 1. 方案目标

本方案针对当前 TaskPilot 的 Notion 推送、邮件自动同步和自动演进逻辑，目标是将现有“创建页面 + 布尔标记 + 防重复”升级为可恢复、可追踪、可更新的同步能力。

### 1.1 主要目标

1. 同一待办在 Notion 中具备稳定的页面关联，修改后默认更新原页面，而不是重复创建。
2. 将用户决策、Notion 远端交付结果、邮件处理结果和自动演进结果拆分建模。
3. 对网络超时、429、5xx、成功但响应异常等不确定结果提供人工核对和恢复路径。
4. 只使用满足业务条件的用户最终样本进行自动演进，避免技术失败污染偏好学习。
5. 让手动推送、邮件手动推送、邮件自动推送共享同一套同步服务和状态转换规则。
6. 通过迁移、自动化测试和可回滚设计，降低现有历史数据升级风险。

### 1.2 非目标

本轮方案不包含以下内容：

- 不改变 Notion 数据库的业务字段定义；
- 不自动删除 Notion 中已有页面；
- 不把“同标题任务”直接判定为同一业务任务；
- 不在没有用户确认的情况下批量修改历史 Notion 页面；
- 不在本方案阶段提交或推送 GitHub。

## 2. 当前实现摘要

当前实现的主要行为如下：

- `syncToNotion` 以 `POST /v1/pages` 为主，逐条串行创建页面；
- 本地幂等记录以 `databaseId:todo.id` 为键，以请求 body 指纹判断是否重复；
- 成功后主要写入 `todo.synced` 和结果级 `syncedToNotion`；
- `SyncResult.pageId` 已由同步层返回，但没有形成稳定的待办—Notion Page 持久关联；
- 内容发生变化后，指纹变化会绕过旧指纹，但因为没有 Page ID 更新路径，仍然倾向于新建页面；
- `unknown` 能阻止盲目重试，但尚未提供完整的人工核对、绑定和解除流程；
- 手动和邮件同步入口会将所选待办传给自动演进，而不是只传远端同步成功的待办；
- 邮件负反馈路径复用 `syncedToNotion` 表示“已处理”，与历史分析中的“已推送”含义冲突；
- 自动演进异常主要写日志，调用方无法准确区分未执行、无变化、失败和成功应用。

详细证据和现状风险见：

`doc/TaskPilot前后端问题评估报告.md` 第 16 节“Notion 推送与自动演进业务逻辑评估”。

## 3. 修改前必须确认的业务决策

以下事项在实现前需要确认。若没有额外产品要求，本方案给出推荐默认值。

| 决策项 | 推荐默认方案 | 原因 |
|---|---|---|
| 修改已推送待办 | 有 `pageId` 时 PATCH 原页面 | 符合“同步”直觉，避免重复页面 |
| 另存新页面 | 作为显式二级操作 | 避免把复制语义隐藏在普通同步中 |
| 用户编辑是否覆盖原始内容 | 保存 `originalSnapshot` 与 `currentSnapshot` | 支持反馈分析、差异展示和回滚 |
| 部分成功 | 逐条记录状态，已成功项不重复处理 | 避免整批重试造成重复和误报 |
| `unknown` 处理 | 默认进入人工核对，不自动强制重试 | 网络结果不确定时不能假设未创建 |
| 人工确认已创建 | 用户提供 Page URL/ID，客户端 GET 校验后绑定 | 比自动搜索更可控，减少误绑定 |
| 自动演进正样本 | 仅明确确认的最终待办；自动邮件默认不参与 | “送达成功”不等于“用户认可” |
| 自动演进应用方式 | 默认生成候选，用户确认后应用 | 防止单条异常样本覆盖全局规则 |
| Notion 字段关联 | 以属性 ID 为稳定主键，名称仅作展示 | 字段重命名不应破坏同步 |
| 旧数据迁移 | 保留旧字段，增量补充新状态 | 支持回滚，避免一次性破坏历史 |

## 4. 推荐业务状态模型

### 4.1 待办用户决策状态

```ts
type UserDecision =
  | 'draft'       // 初始草稿，尚未确认
  | 'approved'    // 用户确认允许交付
  | 'edited'      // 用户修改过，等待确认
  | 'rejected'    // 用户明确拒绝
  | 'archived'    // 已从当前工作流归档
```

`selected` 只作为当前页面的临时 UI 选择，不建议继续把它当作长期业务状态。

### 4.2 Notion 同步状态

```ts
type NotionSyncStatus =
  | 'not_requested'
  | 'queued'
  | 'creating'
  | 'updating'
  | 'succeeded'
  | 'skipped_unchanged'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'unknown_requires_review'
```

状态说明：

- `not_requested`：尚未发起同步；
- `queued`：已进入同步队列；
- `creating`：正在创建 Page；
- `updating`：正在更新已有 Page；
- `succeeded`：创建或更新成功，且保存了有效 Page ID；
- `skipped_unchanged`：已有 Page 且当前快照未变化；
- `failed_retryable`：可安全重试的 4xx 之外的明确失败，或服务暂时不可用但未发生创建歧义；
- `failed_permanent`：字段映射、权限、参数等需用户修改配置后才能解决的失败；
- `unknown_requires_review`：请求可能已到达服务端，但客户端未能确认最终结果。

### 4.3 自动演进状态

```ts
type EvolutionStatus =
  | 'not_eligible'
  | 'queued'
  | 'unchanged'
  | 'candidate_ready'
  | 'applied'
  | 'rejected'
  | 'failed'
```

自动演进状态必须独立于 Notion 状态。Notion 同步失败不能直接导致演进失败；反之，演进失败也不能改变 Notion 交付状态。

## 5. 推荐数据结构

### 5.1 待办数据结构

建议逐步将当前 `TodoItem` 扩展为：

```ts
interface TodoSyncMetadata {
  status: NotionSyncStatus
  pageId?: string
  databaseId?: string
  lastSyncedFingerprint?: string
  lastAttemptAt?: number
  succeededAt?: number
  lastError?: string
  lastOperation?: 'create' | 'update'
  reviewRequired?: boolean
}

interface ManagedTodo extends TodoItem {
  id: string                 // 客户端生成的稳定 UUID，不依赖模型生成
  sourceId: string           // 结果/邮件来源 ID
  originalSnapshot?: Record<string, unknown>
  currentSnapshot?: Record<string, unknown>
  userDecision: UserDecision
  notionSync: TodoSyncMetadata
}
```

兼容期内可以保留旧的 `synced` 字段，但它只作为读取旧数据的兼容字段，不再作为新逻辑的唯一判断依据。

### 5.2 结果与历史数据结构

结果级别建议保存：

```ts
interface EvolutionRecord {
  id: string
  status: EvolutionStatus
  source: 'manual' | 'email' | 'history_analysis'
  sampleTodoIds: string[]
  explicitFeedback?: string
  previousFocus?: string
  candidateFocus?: string
  appliedAt?: number
  error?: string
  createdAt: number
}

interface SyncSummary {
  requested: number
  succeeded: number
  skipped: number
  retryableFailed: number
  permanentFailed: number
  unknown: number
  completedAt?: number
}
```

邮件历史中应拆分至少以下字段：

```ts
{
  reviewStatus: 'unreviewed' | 'reviewed' | 'rejected' | 'feedback_completed',
  notionSyncSummary: SyncSummary,
  evolutionStatus: EvolutionStatus,
  syncedToNotion?: boolean // 仅为旧数据兼容读取，禁止作为新业务判断条件
}
```

## 6. Notion 同步服务改造方案

### 6.1 从“创建”改为“创建/更新/跳过”统一入口

建议保留对外入口 `syncToNotion`，但内部改为显式操作决策：

```ts
type SyncOperation = 'create' | 'update' | 'skip' | 'blocked_unknown'

interface SyncPlan {
  todoId: string
  operation: SyncOperation
  pageId?: string
  fingerprint: string
  reason: string
}
```

推荐决策顺序：

1. 校验 API Key、数据库 ID、字段映射和待办快照；
2. 读取待办自身的 `pageId` 与同步元数据；
3. 已有 `pageId` 且当前指纹等于 `lastSyncedFingerprint`：返回 `skip`；
4. 已有 `pageId` 且指纹变化：执行 PATCH；
5. 没有 `pageId` 且历史记录为 `unknown_requires_review`：阻止自动创建，要求人工处理；
6. 没有 `pageId` 且无未知状态：执行 POST 创建；
7. 成功后同时保存 `pageId`、操作类型、指纹和时间戳；
8. 返回逐条结构化结果，不用整批布尔值代替明细。

### 6.2 API 适配层

在 `src/lib/notionApi.ts` 中集中提供：

```ts
notionPagesEndpoint()
notionPageEndpoint(pageId)
createNotionPage(payload)
updateNotionPage(pageId, payload)
getNotionPage(pageId)
```

建议新增的行为：

- 创建使用 `POST /v1/pages`；
- 更新使用 `PATCH /v1/pages/{page_id}`；
- 人工绑定前使用 `GET /v1/pages/{page_id}` 校验页面存在、可访问且属于目标数据库；
- 页面 ID、URL、数据库归属校验失败时返回 `failed_permanent`；
- API 版本和错误解析集中在 adapter，不在 UI 组件中拼接 URL 或判断状态码。

### 6.3 幂等与未知结果处理

现有 `unknown` 保护应升级为可恢复状态机，而不是永久阻断：

```text
creating/updating
      |
      +-- 明确成功 --> succeeded
      |
      +-- 明确可重试失败 --> failed_retryable
      |
      +-- 明确配置/字段失败 --> failed_permanent
      |
      +-- 超时/429/5xx/响应缺 ID --> unknown_requires_review
```

人工核对操作：

1. **确认已创建/已更新**：输入 Page URL 或 Page ID；调用 GET 校验；绑定 Page ID；根据页面内容重新计算并保存指纹。
2. **确认未创建**：清除未知锁，转为 `failed_retryable`，允许重新创建；必须二次确认，因为该操作可能产生重复页面。
3. **强制创建新页面**：仅作为明确命名的高级操作，不改变已有 Page 的绑定。
4. **重新检查**：对有 Page ID 的记录调用 GET，确认目标页面仍存在；页面被删除后转为 `failed_retryable` 或 `not_requested`。

不建议通过修改标题、日期等业务字段来绕过未知指纹锁；这会让幂等记录和实际业务实体失去对应关系。

### 6.4 字段映射与 Schema 统一

建议新增统一的 Notion schema adapter，至少提供：

```ts
interface NotionFieldSpec {
  notionPropId: string
  notionName: string
  localKey: string
  type: NotionProperty['type']
  options?: string[]
  enabled: boolean
  aiHint?: string
}
```

改造原则：

- `notionPropId` 是稳定关联键；`notionName` 只作展示和兼容；
- `localKey` 是 AI 输出和本地待办使用的稳定字段名；
- AI Prompt schema 描述、响应校验和 Notion payload 序列化都从同一份 `NotionFieldSpec[]` 生成；
- 字段重命名时只更新展示名称，不改变 `localKey` 和属性 ID；
- 对 select/status/multi-select/date/number/checkbox 等字段在进入同步前进行统一校验；
- unsupported 类型在配置页标记，不等到推送时才失败。

## 7. 推送入口与自动演进改造

### 7.1 手动推送

推荐流程：

```text
AI 提取 -> 用户编辑 -> 用户勾选/确认
       -> 生成 SyncPlan
       -> 执行逐条创建/更新
       -> 写回每条 notionSync 状态和 pageId
       -> 生成 SyncSummary
       -> 仅将用户确认的最终快照交给演进模块
```

注意：

- `selected` 是本次提交选择，不代表永久同步成功；
- `succeeded` 只代表 Notion 交付成功，不自动代表用户认可；
- 用户编辑后的 `currentSnapshot` 必须进入同步和学习；
- 部分失败不能覆盖已经成功项的状态；
- 页面按钮应允许“重试失败项”“处理待核对项”，不应要求整批重推。

### 7.2 邮件手动推送

邮件历史需要分别展示：

- AI 已提取；
- 用户已审核；
- Notion 已成功同步；
- 部分失败；
- 待人工核对；
- 用户已拒绝；
- 自动演进状态。

负反馈完成后只能更新 `reviewStatus` 和 `evolutionStatus`，不得修改 `notionSyncSummary` 为成功，也不得设置兼容字段 `syncedToNotion = true`。

### 7.3 邮件自动推送

邮件自动同步没有用户即时确认，因此建议：

- 允许按配置将待办标记为 `approved` 或 `auto_approved`，但与人工确认区分；
- 自动同步只改变 Notion 交付状态，不自动产生正向偏好样本；
- 只有用户后续打开邮件、审核并明确确认后，才允许进入自动演进样本；
- 单个待办失败不应导致已成功待办重复 POST；
- 邮件处理结果应保存逐条摘要，调度器根据待办状态继续处理，而不是只根据整封邮件 `synced` 布尔值重试。

### 7.4 自动演进

将当前 `backgroundReviewAndUpdateFocus` 改为返回结构化结果：

```ts
interface EvolutionResult {
  status: 'not_eligible' | 'queued' | 'unchanged' | 'candidate_ready' | 'applied' | 'failed'
  candidateId?: string
  candidateFocus?: string
  reason?: string
  error?: string
}
```

建议的默认策略：

1. 静态 Prompt 模式返回 `not_eligible`，UI 不显示“已学习成功”；
2. 没有实际修改、拒绝或显式反馈时返回 `unchanged`；
3. 模型生成内容后先保存候选版本，不直接覆盖全局规则；
4. 展示候选规则、变更摘要、样本来源和影响范围；
5. 用户确认后才写入 `autoOptimizedFocus`；
6. 保存上一版本，支持回滚；
7. 模型错误、存储失败和候选为空时返回 `failed` 并进入可重试队列；
8. 历史分析必须过滤拒绝、处理中、技术失败和未确认记录。

## 8. 前端交互优化方案

### 8.1 待办项级状态展示

每条待办应有明确且互斥的状态标签：

- 未同步；
- 同步中；
- 已创建；
- 已更新；
- 内容未变化，已跳过；
- 可重试失败；
- 配置错误；
- 待人工核对。

不要只使用整批“已同步/未同步”按钮状态。

### 8.2 批量操作

建议提供：

- 同步全部已确认项；
- 仅重试失败项；
- 处理待人工核对项；
- 查看已成功项；
- 另存为新页面；
- 取消本次同步。

部分失败时，错误信息应逐条显示，并附带可执行动作，而不是只显示“部分同步失败”。

### 8.3 人工核对弹窗

至少包含：

- 本地任务标题和当前快照；
- 目标数据库；
- 上次操作和时间；
- 错误类型；
- “我已在 Notion 找到该页面，绑定 Page ID”；
- “确认未创建，允许重试”；
- “强制创建新页面”；
- 风险提示和二次确认。

## 9. 数据迁移与兼容方案

### 9.1 迁移原则

- 新增字段，不立即删除旧字段；
- 读取时兼容旧 `synced`、`syncedToNotion`；
- 新写入只写新状态，必要时同步维护旧字段供旧 UI 过渡；
- 所有迁移操作可重复执行，不因重复启动造成数据损坏；
- 迁移前备份 `notion_sync_records.json`、手动历史和邮件历史。

### 9.2 旧数据映射

| 旧数据 | 新数据建议 |
|---|---|
| `todo.synced === true` 且有历史记录 | `notionSync.status = 'succeeded'`，但无 `pageId` 时标记为“旧记录未绑定页面” |
| `syncedToNotion === true` | 仅迁移为 `notionSyncSummary` 的历史兼容值，不能直接推断每条待办成功 |
| 邮件负反馈导致的 `syncedToNotion === true` | 依据 `isRejected` / `feedbackStatus` 迁移为 `reviewStatus = 'rejected'`，不计入成功同步 |
| 旧 pending/unknown 幂等记录 | 映射为 `unknown_requires_review`，不能自动创建 |
| 没有稳定 UUID 的待办 | 启动迁移时生成客户端 UUID，并记录 `legacyId` 供诊断 |

### 9.3 迁移失败处理

迁移失败不得阻止应用启动。应：

1. 保留原始文件；
2. 写入迁移错误日志；
3. 使用只读兼容模式展示数据；
4. 提供导出/恢复入口；
5. 在用户确认前不执行批量 Notion 写操作。

## 10. 实施分期

### 阶段 A：状态和样本边界（P1）

目标：先修正业务事实，不改变 Notion 页面数量语义。

- 新增待办级 `notionSync` 和结果级 `syncSummary`；
- 移除负反馈对 `syncedToNotion` 的错误复用；
- 自动演进返回结构化状态，不吞异常；
- 仅使用明确合格样本；
- 补充状态迁移和回归测试；
- UI 先支持区分成功、失败、unknown、拒绝。

### 阶段 B：Page 关联和 Upsert（P1）

目标：支持修改原页面，避免重复创建。

- 持久化 `pageId`；
- 新增 GET/PATCH API adapter；
- 实现 create/update/skip 计划；
- 保存每次成功指纹和操作类型；
- 手动入口和邮件入口统一调用同步服务；
- 迁移无 pageId 的旧成功数据为待绑定状态。

### 阶段 C：未知结果人工恢复（P1）

目标：让 `unknown` 可处理、可审计、可恢复。

- 增加 Page ID/URL 校验；
- 增加“确认已创建”和“确认未创建”操作；
- 记录人工核对人、时间、理由；
- 允许逐条重试，不重推整批成功项；
- 对强制创建新页面增加二次确认。

### 阶段 D：Schema 和映射统一（P2）

目标：避免 AI 输出、字段映射和 Notion serializer 漂移。

- 引入统一 `NotionFieldSpec`；
- 属性 ID 作为稳定主键；
- 统一生成 Prompt schema、响应校验和 payload；
- 配置页提前提示不支持或不完整的字段。

### 阶段 E：自动演进治理（P2）

目标：使偏好学习可解释、可确认、可回滚。

- 生成候选 Prompt 版本；
- 展示 diff 和样本来源；
- 用户确认后应用；
- 保存版本历史和回滚入口；
- 增加样本最小数量、去重和质量门槛；
- 明确邮件样本隐私范围和参与开关。

## 11. 建议的代码模块拆分

建议在不立即重构 UI 的前提下，逐步引入以下模块：

```text
src/lib/notion/
  types.ts              # 状态、请求、结果类型
  schema.ts             # 字段规范、校验、Prompt 描述
  payload.ts            # create/update payload 构建
  api.ts                # GET/POST/PATCH API adapter
  syncPlan.ts           # create/update/skip/unknown 决策
  syncStore.ts          # 本地状态和迁移
  syncService.ts        # 统一执行入口
  reviewService.ts      # unknown 人工核对和 page 绑定

src/lib/evolution/
  types.ts              # EvolutionResult/EvolutionRecord
  eligibility.ts         # 样本资格过滤
  candidate.ts           # 候选生成和版本保存
  apply.ts               # 用户确认应用和回滚
```

兼容期可以从现有 `src/lib/notion.ts`、`src/lib/notionApi.ts` 和 `src/lib/autoOptimize.ts` 中逐步抽取，不建议一次性大规模移动所有代码。

## 12. 自动化测试方案

### 12.1 Notion API 与序列化

- 创建 payload 使用目标数据库 ID；
- 更新 payload 使用目标 Page ID；
- GET 页面归属校验成功/失败；
- 属性重命名后仍按属性 ID 生成正确 payload；
- select/status/multi-select/date/number/checkbox 的合法与非法输入；
- 不支持字段在推送前被拦截。

### 12.2 同步状态机

- 首次推送无 Page ID -> `creating` -> `succeeded`；
- 有 Page ID 且指纹变化 -> `updating` -> `succeeded`；
- 有 Page ID 且指纹未变化 -> `skipped_unchanged`；
- 408/429/5xx/超时/缺少响应 ID -> `unknown_requires_review`；
- 明确字段或权限错误 -> `failed_permanent`；
- 可重试错误只重试失败项；
- 同一条待办不会因重复调用创建两个页面；
- 多个入口并发调用仍保持状态更新顺序。

### 12.3 人工核对

- 绑定有效 Page ID 后解除 unknown；
- 绑定不存在或不属于目标数据库的 Page ID 被拒绝；
- 确认未创建后允许重试；
- 强制创建必须显式确认；
- 绑定后下一次修改调用 PATCH 而不是 POST。

### 12.4 自动演进

- 静态模式返回 `not_eligible`；
- 无变化返回 `unchanged`；
- 模型异常、空结果、存储异常返回 `failed`；
- 成功生成候选但未确认时为 `candidate_ready`，不得覆盖当前规则；
- 用户确认后为 `applied`，并保存上一版本；
- 负反馈不会改变 Notion 同步状态；
- 失败/unknown/处理中/拒绝样本不会进入正向历史分析；
- 自动邮件未人工确认时默认不进入正向学习。

### 12.5 UI/E2E

- 手动推送成功、部分失败和 unknown 的标签与操作正确；
- 邮件同步与主界面同步使用同一状态语义；
- 刷新或重新打开应用后状态和 Page ID 保持；
- 自动演进候选可查看、应用、忽略、回滚；
- 旧历史迁移后页面可正常展示，且不会自动发起批量同步。

## 13. 验收标准

### 13.1 业务验收

- 修改已同步任务后，默认更新原 Notion Page；
- 普通重复同步不创建重复页面；
- 用户可以处理 unknown，不需要通过修改任务内容绕过锁定；
- 部分成功不会重复同步已成功项；
- 拒绝事项不会显示为“已推送”；
- 自动演进不会把技术故障误判为用户偏好；
- 自动演进修改可追溯、可确认、可回滚。

### 13.2 工程验收

- 前端单元测试覆盖状态机、payload、迁移和演进资格过滤；
- Rust/前端静态检查通过；
- 不使用真实 API Key 的测试可在 CI 稳定运行；
- 真实 Notion 联调只在用户测试数据库中执行；
- 方案实施期间不直接更新 GitHub，待人工核查后再提交/推送。

### 13.3 可观测指标

建议记录以下指标，但不要记录 API Key、完整邮件正文或敏感字段：

- 创建成功率、更新成功率、跳过率；
- 4xx、429、5xx、超时和 unknown 数量；
- unknown 平均人工处理时长；
- 重试后成功率；
- 重复页面事件数；
- 自动演进候选生成、应用、忽略、回滚数量；
- 进入演进的样本来源和资格原因。

## 14. 推荐落地顺序

建议按以下顺序实施，不要直接先增加“再次同步”按钮：

1. 先建立状态类型和数据迁移；
2. 修正负反馈、部分失败与自动演进的事件边界；
3. 统一 Notion schema 和字段映射；
4. 保存 Page ID 并实现 GET/PATCH；
5. 实现 unknown 人工核对和逐条恢复；
6. 改造手动、邮件手动、邮件自动三个入口；
7. 补齐自动化测试和测试数据库联调；
8. 最后启用自动演进候选、确认、回滚流程。

## 15. 待用户确认事项

在开始修改代码前，请确认以下默认决策是否成立：

- [ ] 修改待办后默认 **更新原 Notion Page**，不默认创建新页面；
- [ ] 无法确认远端结果时，默认进入人工核对，不自动强制重试；
- [ ] Notion 同步成功与用户认可拆分，技术成功不直接等同偏好正样本；
- [ ] 邮件自动同步默认不参与自动演进，除非用户后续明确审核确认；
- [ ] 自动演进默认生成候选，用户确认后才覆盖全局关注点；
- [ ] 旧数据先兼容迁移，不立即删除旧字段和旧历史；
- [ ] 本方案确认后再进入代码实现阶段，实施期间不自动提交或推送 GitHub。

## 16. 方案结论

Notion 同步优化的核心不是单纯增加 PATCH 接口，而是先建立“**用户决策、远端交付、未知结果、历史学习**”四条相互独立但可关联的业务链。

推荐的最终产品语义为：

> 用户确认一条待办后，TaskPilot 使用稳定任务 ID 和已绑定的 Notion Page ID 执行幂等 Upsert；远端结果逐条可追踪，未知结果必须人工核对；只有用户明确确认的最终内容才可作为自动演进样本；自动演进默认以可审计候选形式交付，并支持应用和回滚。

在上述状态模型和验收用例落地前，不建议继续扩展当前仅依赖 `synced` / `syncedToNotion` 的 Notion 推送逻辑。
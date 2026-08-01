# TaskPilot 前后端问题评估报告

- **评估日期**：2026-08-01
- **评估对象**：`task-pilot` 核心项目（`C:\MyCode\Tempdir\Taskpliot\task-pilot`）
- **代码基线**：`main` 分支，提交 `bfd628e`
- **范围**：React/TypeScript 前端、Tauri/Rust 后端、前后端 IPC、邮件与 Notion 集成、AI 调用、持久化、安全配置、自动化测试与 CI。
- **不在范围内**：`example` 下的参考工程未作为生产实现的一部分进行缺陷判定；仅在协议/API 演进风险中作为辅助对照。

---

## 1. 结论摘要

项目已形成可构建的 Tauri + React 桌面应用闭环：文本/文件/图片提取、AI 多服务商调用、IMAP 邮件扫描、Notion 同步、历史记录和快捷键等主功能均已有实现。当前 TypeScript 类型检查和生产前端构建可以通过，Rust 单元测试也全部通过。

但在**安全、前后端契约、可靠性和测试可信度**上存在需要优先处理的问题。最重要的风险是：

1. **仓库中的 E2E 测试包含硬编码的真实形态 API 凭据，并会在 CI 中调用外部服务。** 这会带来密钥泄露、滥用、费用和供应链风险。
2. **来自 IMAP 邮件的原始 HTML 未经消毒便使用 `dangerouslySetInnerHTML` 渲染，同时 Tauri CSP 被设为 `null`。** 攻击者可以通过邮件内容形成持久化的 WebView XSS 攻击面。
3. **本地加密密钥存在明文文件和可预测机器标识回退路径；邮件历史只以 `.enc` 命名，项目代码未对其实施加密包装。** 当前“本地加密”不能作为强安全边界。
4. **快捷键录制的前后端 IPC 未对齐：前端调用未注册的 `unregister_shortcut`，而后端的 `set_recording_mode` 没有被前端调用。** 会造成录制快捷键时的行为异常。
5. **IMAP 请求在 `async` 命令中执行同步网络 I/O，缺少连接/读取超时和真正的取消机制；同时会拉取整封邮件后才做图片大小限制。** 邮箱异常、超大邮件或网络抖动会影响界面响应和扫描稳定性。

建议将本报告的 **P0 项在发布或继续启用 CI 前完成处置**，随后按 P1 计划进行架构收敛和回归测试补齐。

---

## 2. 评估方法与基线结果

### 2.1 检查方法

- 阅读核心前端、Rust 后端、Tauri capability、CI 与测试配置。
- 对照前端 `invoke(...)` 调用与 Rust `invoke_handler` 注册命令。
- 审查邮件 HTML 渲染、密钥存储、网络权限、AI/Notion/IMAP 调用链。
- 执行本地静态检查、构建和单元测试；不执行包含外部真实凭据的 E2E。

### 2.2 实际执行结果

| 命令/检查 | 结果 | 说明 |
|---|---:|---|
| `npx tsc --noEmit` | 通过 | TypeScript 无编译错误。 |
| `npm run build` | 通过但有警告 | Vite 输出主 JS 约 1.65 MB（gzip 约 480 KB），PDF Worker 约 1.25 MB；提示存在超 500 KB chunk。 |
| `npm test` | **失败** | 5 个测试文件中 4 个通过；10 个用例中 9 个通过，`src/lib/ai.test.ts` 有 1 个陈旧断言失败。 |
| `npx oxlint .` | 通过但有 7 条警告 | 主要为 React Hook 依赖遗漏、未使用变量。 |
| `cargo test` | 通过 | Rust 6 个单元测试全部通过；同时提示 `imap-proto v0.10.2` 含未来 Rust 版本不兼容项。 |
| `cargo clippy --all-targets -- -D warnings` | **失败** | 发现冗余 import、可折叠分支，以及 `fetch_emails` 参数过多。 |
| `cargo fmt -- --check` | **失败** | Rust 源码未按 rustfmt 格式化。 |
| `npm run lint` | **不可用** | 脚本调用 `eslint .`，但项目未安装/无法解析 `eslint`；CI 又以 `|| true` 忽略该失败。 |
| E2E | 未执行 | 测试代码含硬编码外部 API 凭据，不应在当前状态下运行。 |

---

## 3. 风险分级说明

| 级别 | 含义 | 建议处理窗口 |
|---|---|---|
| **P0 / 紧急** | 已存在安全泄露或可被外部输入触发的高危攻击面，或会导致不受控费用/数据外泄。 | 立即处置，发布/CI 前完成。 |
| **P1 / 高** | 关键业务可靠性、数据一致性或核心功能可用性缺陷。 | 下一迭代优先完成。 |
| **P2 / 中** | 可维护性、兼容性、性能或测试质量问题。 | 纳入近期重构计划。 |
| **P3 / 低** | 工程卫生、体验和文档一致性改进。 | 与相关功能一并治理。 |

---

## 4. P0 / 紧急问题

### SEC-01：E2E 测试中存在硬编码的外部 API 凭据

- **位置**：`test/e2e/main.spec.ts:16-25`
- **证据**：测试直接设置固定 API Base URL、固定 API Key 和模型名；CI 配置会执行 `npm run test:e2e`。
- **影响**：
  - 凭据已经进入 Git 工作树，若为有效凭据，可能被克隆者、构建日志、缓存或历史提交滥用。
  - CI 会真实调用外部 AI 服务，造成不可控费用、速率限制和测试不稳定。
  - 即使当前凭据已失效，处理方式本身仍会造成未来再次泄露。
- **整改建议**：
  1. 立即在服务端撤销并轮换该凭据；不要在报告、Issue、提交信息或日志中再次粘贴其值。
  2. 从当前文件和 Git 历史中移除该秘密；按仓库托管平台流程进行历史清理和凭据泄露告警处置。
  3. 将 E2E 改为本地 mock server 或 Tauri IPC mock；若必须联调，使用 CI Secret 注入、最小权限短期 token、独立测试租户和用量上限。
  4. 在 CI 增加 secret scan（如 gitleaks/trufflehog）并设为阻断项。
- **验收**：代码库、Git 历史和 CI 日志均不再含明文凭据；E2E 无外网真实模型依赖即可稳定运行。

### SEC-02：邮件原始 HTML 未消毒直接渲染，且 CSP 被关闭

- **位置**：
  - `src/EmailTasksPanel.tsx:951-957`、`1028-1031`、`1059-1063`、`1081-1085`
  - `src/EmailTasksPanel.tsx:18-46`
  - `src-tauri/tauri.conf.json` 中 `app.security.csp: null`
- **证据**：邮件 `htmlBody` 和基于其切片得到的内容直接传入 `dangerouslySetInnerHTML`；`getDarkModeHtml` 仅修改颜色/背景，不移除脚本属性、危险 URL、表单、iframe 或事件处理器。
- **影响**：恶意发件人可通过邮件 HTML 创建 XSS 攻击面。由于内容还会被持久化到邮件历史，在用户后续打开历史记录时可能再次触发。CSP 被设为 `null` 会进一步降低 WebView 对脚本、外部资源和危险执行路径的防护。
- **整改建议**：
  1. 渲染前使用严格白名单 HTML sanitizer（例如 DOMPurify），显式禁止 `script`、事件属性、`iframe`、`object`、`embed`、`form`、`svg`/MathML 的危险特性及 `javascript:` URL。
  2. 外部图片默认不加载；必要时经代理/本地缓存并显示用户确认提示，防止邮件追踪像素泄露本机网络信息和阅读行为。
  3. 恢复并收紧 Tauri CSP；只允许应用自身资源和被明确需要的网络目标。
  4. 最稳妥的阅读模式是将邮件 HTML 放入受限 sandboxed iframe，或优先显示转义后的纯文本。
  5. 为恶意 HTML 样例增加单元/E2E 安全回归测试。
- **验收**：恶意 `onerror`、`javascript:` 链接、iframe、外链资源和内联脚本均无法执行或发起请求；邮件仍可正常显示文字、表格和可信图片。

### SEC-03：本地密钥与历史数据保护强度不足

- **位置**：
  - `src-tauri/src/lib.rs:34-67`：历史密钥会写入应用数据目录 `secret.key`。
  - `src-tauri/src/lib.rs:230-274`：凭据密钥在 keyring 失败时退回为 `SHA-256(machine_uid)`。
  - `src/lib/emailScheduler.ts:29`：邮件历史使用 `LazyStore('email_history.enc')`。
  - `src/store.ts:19-69`：仅 API Key、Notion Key、IMAP 密码和 provider Key 调用 `encrypt_secret`。
- **影响**：
  - 历史密钥的明文回退文件可被同一系统账户或具备本地文件访问能力的攻击者读取。
  - `machine_uid` 派生密钥没有用户秘密、随机盐或独立密钥材料，不能等同于安全密钥库。
  - 邮件历史文件的扩展名为 `.enc`，但项目代码没有在读写该 `LazyStore` 前后执行加密/解密；不能仅凭文件名将其视为加密数据。
  - 历史中可能包含原始输入、邮件正文、HTML、内嵌图片、AI 结果和同步状态，属于高敏感数据。
- **整改建议**：
  1. 将所有密钥仅保存在 OS Credential Manager/keyring；若不可用，应明确失败并提示用户，而不是回退到可预测机器标识。
  2. 取消 `secret.key` 明文回退；若出于兼容性必须保留，至少使用用户提供的口令经 Argon2id/PBKDF2 派生，并设置严格 ACL、版本号和迁移期限。
  3. 对邮件历史和主历史采用同一套带版本、随机 nonce、认证标签和原子写入的加密存储层；不要以扩展名表示“已加密”。
  4. 增加密钥轮换、数据迁移失败提示、删除本地数据和导出前脱敏机制。
- **验收**：应用数据目录不再保存可直接使用的明文密钥；无 keyring 时不会静默降级为机器 ID；邮件和历史文件经独立测试确认不可被明文读取。

---

## 5. P1 / 高优先级问题

### INT-01：快捷键录制 IPC 不一致，后端录制状态未生效

- **位置**：
  - 前端调用：`src/SettingsPanel.tsx:153-160`
  - Rust 注册命令：`src-tauri/src/lib.rs:335`
  - 后端状态命令：`src-tauri/src/lib.rs:224-228`
- **证据**：前端在录制快捷键时调用 `unregister_shortcut`，但 Rust 未注册该 command；Rust 中存在 `set_recording_mode`，前端却没有调用。
- **影响**：录制阶段旧快捷键不会被预期地取消注册；全局快捷键仍可能触发窗口显示/隐藏，干扰录制流程。
- **建议**：统一命令契约：要么新增并注册 `unregister_shortcut`，要么由 `set_recording_mode(true)` 暂停快捷键回调；结束录制后进行参数校验、原快捷键恢复和错误提示。为“开始录制—按键—取消—保存失败—恢复”增加 IPC 集成测试。

### BE-01：IMAP 同步网络 I/O 在 async command 中阻塞，缺少超时和可取消请求

- **位置**：`src-tauri/src/imap_cmds.rs:19-47`、`104-180`、`183-211`
- **证据**：`async fn` 内直接执行同步 `imap::connect`、`login`、`uid_search`、`uid_fetch`、`uid_store`；没有 `spawn_blocking`、连接/读取超时或取消 token。
- **影响**：网络卡住或服务器异常时会占用 Tauri 运行时线程，扫描的“暂停/停止”只能在邮件之间检查，不能中断正在连接、下载或解析的任务。
- **建议**：
  - 用 `tauri::async_runtime::spawn_blocking` 或迁移到异步 IMAP 客户端；为每一步设置连接、认证、读取和整体任务超时。
  - 将 `AbortHandle`/取消 token 贯穿扫描器、IMAP 与 AI 调用。
  - 将扫描进度和错误按结构化事件回传，而不是只依赖前端轮询状态。

### BE-02：整封邮件下载后才限制图片，存在内存、性能和隐私风险

- **位置**：`src-tauri/src/imap_cmds.rs:65-74`、`143-145`
- **证据**：对每封邮件使用 `BODY.PEEK[]` 下载完整 MIME 内容；图片的 500 KB 限制发生在 `get_body_raw()` 已取得内容之后。代码还会收集所有 `image/*` part，没有区分内联图片与普通附件。
- **影响**：超大附件/邮件会在客户端先被完整下载和解析；无关图片附件可进入前端、邮件历史和 AI 图像压缩流程，造成内存压力、隐私外发和 Token 成本。
- **建议**：先使用 IMAP BODYSTRUCTURE / BODY.PEEK[TEXT] 和按 part 拉取策略；限制邮件总大小、文本大小、HTML 大小、part 数量和单 part 大小；仅保留明确 `Content-Disposition: inline` 或具有 CID 引用的图像。

### BE-03：邮件扫描存在排序、去重和解析失败处理缺口

- **位置**：
  - `src-tauri/src/imap_cmds.rs:139-176`
  - `src/lib/emailScheduler.ts:67-87`、`219-315`
- **证据与影响**：
  - `uid_search` 的结果未倒序，随后 `take(50)` 可能优先处理最旧的 50 封未读邮件；未读积压时新邮件可能长期饥饿。
  - 去重键只有 `folder_uid`，不含 IMAP `UIDVALIDITY`。目录重建、迁移或 UIDVALIDITY 变化后可能错误跳过新邮件。
  - `parse_mail` 失败时被静默忽略，既无日志也不写失败历史；该未读邮件会在后续扫描中重复触发。
  - 手动扫描仍固定传入 `unreadOnly: true`，无法按“手动读取天数”复查已读邮件。
- **建议**：按 UID/日期降序并采用分页；持久化 `(account, folder, uidValidity, uid)`；将解析失败记录为可见失败项并定义重试/忽略策略；让手动扫描的已读/未读范围由 UI 明确控制。

### FE-01：AI/Notion 请求缺少超时、结构校验和请求幂等性

- **位置**：`src/lib/ai.ts:78-157`、`src/lib/notion.ts:20-125`
- **影响**：
  - HTTP 请求无超时与 `AbortController`；网络悬挂会长期占据 UI loading 状态。
  - AI 仅检查 `choices[0].message`，未验证 `content` 类型和待办 JSON schema；服务商兼容差异会在后续解析阶段产生笼统错误。
  - Notion 创建页面没有幂等标识。若远端已写入但客户端未收到成功响应，用户重试会创建重复待办。
  - 当前失败转移会在部分 4xx 情况下多次重试并可能轮换到其他 Provider，可能把同一输入发送到多个服务商，不利于成本控制和数据出境治理。
- **建议**：封装统一 HTTP client，提供超时、取消、可观测 request ID 和错误分类；使用 Zod/JSON Schema 验证模型输出；在 Notion 侧写入稳定的 source UUID/哈希，并在重试前查询或本地记录幂等状态；只对网络、408、429、5xx 执行重试/故障转移，4xx 应按策略直接失败。

### FE-02：Notion “动态字段映射”与实际同步能力不一致

- **位置**：`src/SettingsPanel.tsx:312-358`、`src/lib/notion.ts:51-100`
- **证据**：设置面板读取数据库字段，但同步 `switch` 仅实现 title、rich_text、select、multi_select、date、checkbox、number、url、email、phone_number。`status`、relation、people、files、formula 等字段会被静默跳过；`syncToNotion` 也未直接按 `fieldMappings.enabled` 过滤。
- **影响**：用户看到字段可配置/已启用，但实际 Notion 页面可能缺字段且无显式错误，降低数据完整性和可理解性。
- **建议**：建立 `NotionPropertyType -> serializer` 显式映射，先拒绝不支持字段并在 UI 标识；同步时严格使用已启用映射；逐步补齐 status、relation 等业务字段；为每类字段增加 API fixture 测试。

### FE-03：持久化存在读改写竞争和静默丢失风险

- **位置**：`src/App.tsx:155-212`、`251-352`、`src/HistoryPanel.tsx:88-116`
- **证据**：多个流程各自 `load_history -> JSON.parse -> 修改 -> save_history`；没有互斥、版本号、compare-and-swap 或单一 repository 层。`App.tsx:352` 还显式吞掉保存异常。
- **影响**：提取、同步、负反馈、清空和历史面板操作并发时，后写入者可能覆盖先写入者；失败时用户无法得知同步状态没有落盘。
- **建议**：将历史读写集中为单一 service，使用内存队列/互斥锁、版本字段和原子更新；保存失败展示可恢复提示；为并发更新、损坏 JSON、解密失败和掉电恢复增加测试。

### SEC-04：网络权限过宽，未形成最小权限边界

- **位置**：`src-tauri/capabilities/default.json`
- **证据**：HTTP capability 同时允许 `http://**`、`https://**` 以及多个重复宽泛 URL 模式。
- **影响**：任意前端脚本执行路径（尤其与邮件 HTML XSS 组合时）可向任意 HTTP/HTTPS 地址发起原生网络请求，扩大内网探测、数据外传和 SSRF 类风险。
- **建议**：仅允许明确的 AI 服务域名、Notion 和经用户确认的 IMAP/自定义 Provider 域名。对于用户自定义 provider，建立单独的允许列表/二次确认，禁止默认泛域名和明文 HTTP。

---

## 6. P2 / 中优先级问题

### FE-04：核心 UI 组件过大、类型逃逸较多，维护和回归成本高

- **位置**：`src/SettingsPanel.tsx` 约 92 KB、`src/EmailTasksPanel.tsx` 约 88 KB、`src/App.tsx` 约 38 KB。
- **证据**：业务状态、视图、IPC、持久化、确认弹窗和格式转换混杂在单组件中；`any` 大量出现于 AI payload、邮件、历史和 Notion 数据。
- **影响**：修改任一子功能容易影响其他路径；难以为扫描器、邮件详情、同步和编辑建立小粒度测试。
- **建议**：按“容器组件 + hooks + 领域 service + 展示组件”拆分；为 `Email`、`HistoryRecord`、`NotionPagePayload`、`ChatCompletionResponse` 建立运行时校验与 TypeScript 类型。

### FE-05：React Hook 依赖警告可能造成陈旧闭包

- **证据**：`npx oxlint .` 报告：
  - `src/components/ZenEditorModal.tsx:73` 缺少 `handleSave`、`handleAttemptClose` 依赖。
  - `src/HistoryPanel.tsx:63` 缺少 `selectedDate`。
  - `src/EmailTasksPanel.tsx:129` 缺少 `reviewFilterReviewed`、`toggleReviewed`。
- **影响**：在 props 或筛选条件变化后，键盘操作、历史日期和审核跳转可能使用旧状态。
- **建议**：使用 `useCallback` 固化 handler，并完整声明依赖；针对键盘处理、筛选切换和历史恢复添加交互测试。

### FE-06：本地文件解析没有大小、页数和工作量上限

- **位置**：`src/lib/parser.ts:9-94`、`src/App.tsx:130-151`
- **影响**：大 PDF、复杂 Excel 或 DOCX 可在渲染进程中占用大量内存/CPU；解析结果会再进入文本输入和 AI payload。
- **建议**：在读取前限制文件大小和数量，对 PDF 限页，对 Excel 限 sheet/行数/字符数，解析放入 Web Worker 或 Rust worker，并向用户显示截断信息。

### BE-04：Rust 代码存在未格式化、Clippy 未通过及运行期 `unwrap`

- **位置**：`src-tauri/src/lib.rs`、`src-tauri/src/imap_cmds.rs`
- **证据**：`cargo fmt -- --check` 失败；Clippy 的 `-D warnings` 失败；运行期窗口/路径逻辑中有多个 `unwrap()`，如 `src-tauri/src/lib.rs:21-22`、`348-353`、`387-392`。
- **影响**：路径不可用、窗口状态错误等少见场景可能导致整个桌面进程 panic；代码风格和静态质量无法作为 CI 门禁。
- **建议**：先执行并提交 rustfmt；消除 Clippy 告警；将运行期 `unwrap` 改为 `Result` 处理和日志记录，尤其是窗口操作、应用数据目录和默认图标获取。

### QA-01：单元测试存在陈旧断言，E2E 设计不确定且不安全

- **证据**：
  - `src/lib/ai.test.ts:44` 断言请求中应包含未传入的 `Buy milk`，使 `npm test` 失败。
  - `test/e2e/main.spec.ts` 使用注释 “Update selector based on actual implementation”、真实外部 API、固定等待和可能已不存在的 selector。
  - `wdio.conf.ts` 只执行 `cargo build --release`，未显式建立适用于 E2E 的前端产物和隔离测试配置。
- **建议**：修复或删除陈旧断言；使用 mock AI/Notion/IMAP server；采用稳定的 `data-testid`；把 E2E 与真实集成测试分层，后者仅在受控环境和 CI Secret 下运行。

### QA-02：CI 未把 lint 作为门禁

- **位置**：`.github/workflows/test.yml`
- **证据**：`npm run lint || true` 会吞掉 lint 失败；当前 `package.json` 的 lint 脚本调用未安装的 `eslint`。
- **建议**：统一选择 ESLint 或 Oxlint。若使用 Oxlint，将脚本改为 `oxlint .` 并在 CI 中移除 `|| true`；对 TypeScript、单测、Rust fmt、Clippy、secret scan 都设置阻断。

### PERF-01：前端首包偏大且动态导入没有实现预期拆包

- **证据**：构建输出主 JS 约 1.65 MB（gzip 约 480 KB），PDF worker 约 1.25 MB；Vite 报告动态导入 Tauri core 无法拆分。
- **建议**：按 Settings、EmailTasks、History、PDF 解析等重组件路由/懒加载；将 PDF worker 延迟加载；避免仅为调用 API 使用无效动态 import。

### COMP-01：Notion API 契约和文档存在演进风险

- **证据**：当前实现固定使用 `Notion-Version: 2022-06-28` 及 `/v1/databases/{id}`，而参考脚本和文档中出现 data source / database 的新模型描述。
- **影响**：Notion 平台升级或用户使用新数据源模型时，字段读取/写入可能失败或行为不一致。
- **建议**：将 Notion API 版本、读取端点和数据模型抽象为单一 adapter；补齐接口契约测试，明确支持版本和迁移策略。

---

## 7. P3 / 工程卫生与文档一致性问题

| 编号 | 问题 | 建议 |
|---|---|---|
| ENG-01 | `src-tauri/2` 是被追踪的 npm 安装输出文本，不属于源代码。 | 删除并补充忽略/提交前检查。 |
| ENG-02 | 文档中若干 IPC 名称、Rust 文件解析职责、`llmFailover.ts` 等描述与当前实现不完全一致。 | 建立“代码为准”的接口清单，版本化维护设计文档。 |
| ENG-03 | 日志没有大小上限、轮转和字段级脱敏策略。 | 设定最大文件大小/保留天数，禁止记录用户邮件正文、完整模型响应和敏感错误回显。 |
| ENG-04 | `getSortedLLMProviders()` 在读取配置时通过 `setTimeout` 产生状态副作用。 | 将旧配置迁移放在 store hydration/migration 中，保持 getter 纯函数。 |

---

## 8. 推荐整改路线图

### 阶段 A：立即处置（P0，发布/CI 前）

1. 撤销硬编码外部凭据，清理文件与 Git 历史，并启用 secret scan。
2. 下线或隔离当前 E2E；移除真实外网模型调用。
3. 对邮件 HTML 加 sanitizer，恢复并收紧 CSP，默认阻断外部资源。
4. 取消明文/确定性密钥回退，为历史和邮件历史设计统一加密存储。

### 阶段 B：核心可靠性（P1）

1. 修复快捷键 command 契约，补 IPC 集成测试。
2. 为 AI、Notion、IMAP 加统一超时、取消、错误分类和结构化日志。
3. 将 IMAP 同步 I/O 移出 async runtime 阻塞路径，并限制邮件/附件资源消耗。
4. 修复 UID 排序、UIDVALIDITY、解析失败记录和手动扫描范围。
5. 为 Notion 同步加入字段支持矩阵、幂等标识和失败重试策略。
6. 统一历史读写 service，消除并发读改写覆盖和静默保存失败。

### 阶段 C：质量与可维护性（P2/P3）

1. 拆分 `SettingsPanel`、`EmailTasksPanel`、`App`，将领域逻辑转为 hooks/service。
2. 移除 `any`，为 IPC 与第三方响应使用 schema 校验。
3. 修复 Vitest 陈旧断言；将 mock、集成和 E2E 分层。
4. 修复 lint 脚本和 CI 门禁，纳入 `fmt`、`clippy`、secret scan。
5. 代码分割 PDF 和重型面板，降低启动与内存压力。
6. 更新设计文档和 API 契约，明确支持的 Notion 字段与 Provider 兼容范围。

---

## 9. 建议验收清单

整改完成后，至少应满足以下条件：

- [ ] 仓库、历史和 CI 日志不存在任何真实凭据；secret scan 为必经门禁。
- [ ] 恶意邮件 HTML 不可执行脚本、事件属性、危险 URL 或外部追踪资源。
- [ ] API Key、IMAP 密码、主历史和邮件历史均可验证为加密存储，且无可预测/明文密钥回退。
- [ ] 前端所有 `invoke` 命令都可在 Rust `invoke_handler` 中找到注册项，并有契约测试。
- [ ] IMAP/AI/Notion 都具有超时、取消、重试分类和可观测错误信息。
- [ ] Notion 映射 UI 显示的字段均有明确支持状态；同步具备幂等保护。
- [ ] `npm test`、lint、TypeScript、`cargo fmt --check`、Clippy、`cargo test` 均通过。
- [ ] E2E 使用 mock 服务且不依赖真实账号、外网和固定等待。
- [ ] 设计文档与实际命令、数据存储和解析职责保持一致。

---

## 10. 附：初始评估范围说明

本报告第 1 至第 10 节记录的是 **P1 整改前** 的代码基线和评估结论。初始评估阶段仅新增本报告；后续本地 P1 代码、测试和配置修改已在第 11 节单独记录。P0 项仍未处理，不能因 P1 通过构建而视为安全发布状态。

---

## 11. P1 整改执行记录（2026-08-01，本地未提交）

> 本节记录在本地工作区完成的 P1 整改；**P0 项（硬编码凭据、邮件 HTML 消毒/CSP、本地加密密钥体系）未在本轮修改中处理，仍必须优先处置。**

| 原问题 | 本次本地整改 | 关键文件 |
|---|---|---|
| INT-01 快捷键 IPC 不一致 | 新增并注册 `unregister_shortcut`；录制时前端显式调用 `set_recording_mode(true)` 和注销快捷键，退出录制时恢复持久化快捷键。 | `src/SettingsPanel.tsx`、`src-tauri/src/lib.rs` |
| BE-01 IMAP 阻塞和无超时 | IMAP 同步操作移入 `spawn_blocking`；增加 15 秒连接超时、30 秒读写超时。 | `src-tauri/src/imap_cmds.rs` |
| BE-02/BE-03 邮件资源、顺序、解析与去重缺口 | 邮件按最新 UID 优先；使用 RFC822.SIZE 在完整下载前拒绝超过 5 MB 的邮件；只保留非附件图片；向前端返回 UIDVALIDITY；解析失败写入可见失败历史并停止重复扫描；手动扫描可读取时间窗内邮件。 | `src-tauri/src/imap_cmds.rs`、`src/lib/emailScheduler.ts` |
| FE-01 AI/Notion 请求可靠性 | 新增 30 秒 HTTP 超时包装；AI 响应做结构校验；仅网络、超时、408、429、5xx 触发重试/故障转移，4xx 不再跨 Provider 发送同一内容。 | `src/lib/http.ts`、`src/lib/ai.ts`、`src/SettingsPanel.tsx` |
| FE-02 Notion 映射和幂等性 | 同步仅发送已启用字段；新增 `status`、`relation` 序列化；不支持字段返回可见错误；增加本地同步状态记录，成功请求不会重复创建，未知结果会阻止自动重试。 | `src/lib/notion.ts`、`src/SettingsPanel.tsx`、`src/lib/notion.test.ts` |
| FE-03 历史读改写竞争 | 新增串行化历史 repository，主界面、历史面板和自动优化统一使用，移除静默吞掉的主同步保存异常。 | `src/lib/history.ts`、`src/App.tsx`、`src/HistoryPanel.tsx`、`src/lib/autoOptimize.ts` |
| SEC-04 网络权限过宽 | 移除 `http://**` 与 `https://**`，改为 OpenAI、Notion、常用受支持 Provider 和本地 Ollama 的显式 allowlist。 | `src-tauri/capabilities/default.json` |

### 本地核查结果

- `npm test`：7 个测试文件、14 个用例全部通过。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过。
- `cargo test`：6 个用例全部通过。
- `cargo clippy --all-targets -- -D warnings`：通过。
- `cargo fmt -- --check`：通过。
- `npm run tauri build`：通过，已成功生成本地 MSI 和 NSIS 包。

### 需由人工继续核查的行为变更

1. 网络 allowlist 会阻止未列出的自定义 Provider 域名；如确有业务需要，应先审核目标域名，再显式添加到 capability allowlist，避免恢复泛域名权限。
2. Notion 同步状态为“未知”时会故意阻止自动重试，以防止重复建页；需先在 Notion 中人工核对后再决定如何清理/恢复该同步记录。
3. IMAP 全量联调需要使用测试邮箱验证：目录读取、超时提示、超大邮件跳过、附件图片过滤、UIDVALIDITY 去重、手动扫描已读邮件和快捷键录制。
4. P0 安全项仍未修复，不应因 P1 通过本地构建而视为可安全发布。

---

## 12. 自动化测试完善记录（2026-08-01）

> 本节反映当前**本地未提交工作区**的最新状态，用于覆盖第 2 节基线检查和第 11 节早期整改记录中的测试数据。全程未执行 `git commit`、`git push`、PR 创建或任何 GitHub 更新。

### 12.1 本轮新增/强化的测试

| 测试层级 | 文件 | 新增覆盖的关键行为 | 隔离方式 |
|---|---|---|---|
| AI 服务调用 | `src/lib/ai.test.ts` | 无 API Key 拦截、正常请求负载、400 不重试、网络错误触发服务商故障转移、成功响应结构异常不跨服务商转发 | mock `@tauri-apps/plugin-http` |
| HTTP 基础设施 | `src/lib/http.test.ts` | 默认 30 秒超时、Abort 转换为超时错误、408/429/5xx 与网络错误的可重试分类 | fake timer + mock HTTP |
| Notion 同步 | `src/lib/notion.test.ts` | 只写入启用字段、成功后的幂等跳过、`status`/`relation` payload、Schema 选项校验、503 后标记 `unknown` 并阻止自动重复创建 | mock HTTP + 内存 LazyStore |
| 邮件调度 | `src/lib/emailScheduler.test.ts` | 手动扫描读取已读邮件及时间窗、MIME/超大邮件解析失败落历史、`UIDVALIDITY + UID + folder` 去重（UIDVALIDITY 变化按新邮件处理） | mock Tauri `invoke` + 内存 LazyStore |
| 历史记录 | `src/lib/history.test.ts` | 并发读改写串行化、一次保存失败后队列继续处理后续写入 | mock Tauri `invoke` |
| 快捷键 IPC | `src/SettingsPanel.test.tsx` | 录制开始时调用 `set_recording_mode(true)` 与 `unregister_shortcut`；失焦后恢复持久化快捷键 | jsdom + mock Tauri `invoke` |
| 桌面 E2E 冒烟 | `test/e2e/main.spec.ts`、`wdio.conf.ts` | 移除真实 API 凭据和 AI 提取调用；仅验证应用主窗口和设置面板可打开 | WebdriverIO/Tauri Driver（当前未执行） |

### 12.2 本次已执行的自动化与静态验证

| 命令 | 结果 | 说明 |
|---|---:|---|
| `npm test` | **通过：9 个测试文件、26 个用例** | 所有 HTTP、AI、Notion、邮件调度、历史、快捷键和既有测试均通过；不调用真实模型、Notion 或邮箱。 |
| `npx tsc --noEmit` | 通过 | TypeScript 类型检查通过。 |
| `npm run build` | 通过（有性能警告） | 前端生产构建通过；仍有大 Chunk 和动态导入无法拆包的 Vite 警告。 |
| `cargo test` | **通过：6 个用例** | Rust IMAP MIME 解析和密钥加解密测试通过。 |
| `cargo clippy --all-targets -- -D warnings` | 通过 | 无 Clippy 阻断项。 |
| `cargo fmt -- --check` | 通过 | Rust 格式检查通过。 |

### 12.3 E2E 当前状态与执行前置条件

- 现有 E2E 已改为**无真实凭据、无外部 AI/Notion/IMAP 调用**的桌面 UI 冒烟测试；原先硬编码在测试中的敏感值已从当前工作区测试文件中移除。
- 本机在 **2026-08-01** 检查时未发现 `tauri-driver` 可执行文件，因此没有执行 `npm run test:e2e`。这是环境前置条件缺失，而非将失败结果记为通过。
- 运行该层前，应安装与项目 Tauri/WebDriverIO 版本兼容的 `tauri-driver`，并在隔离的测试用户目录执行；不得恢复真实凭据或外部服务依赖。
- 当前 `tsconfig` 仅包含 `src` 和 Vite 配置，E2E TypeScript 文件不属于 `npx tsc --noEmit` 的编译范围；后续 CI 应为 `test/e2e` 增设独立 TypeScript 校验。

### 12.4 仍未覆盖或只能通过集成环境验证的风险

1. **IMAP 协议集成测试未完成**：还需本地 Mock IMAP Server 覆盖连接/读写超时、目录异常、附件大小限制、暂停/停止及真实 UIDVALIDITY 变化。
2. **Notion 不确定结果的人工恢复流程未完成**：`unknown` 状态可防止重复建页，但当前尚无“人工核对后清除/强制重试”的 UI 和自动化测试。
3. **真实桌面 E2E 未执行**：需在具备 `tauri-driver` 的隔离环境运行，并使用稳定的 `data-testid` 替代脆弱的文本/placeholder 选择器。
4. **安全回归测试未完成**：邮件 HTML 注入/CSP 和本地密钥回退两个 P0 项仍需完成修复后，才可增加 XSS、外链资源和密钥存储的自动化安全回归。
5. **外部服务契约未做联调**：本轮故意使用 mock，不能替代测试邮箱、测试 Notion 数据库和受控 Mock AI 服务的端到端验收。

### 12.5 测试结论

当前自动化测试已从基础成功路径扩展到 P1 可靠性回归场景，能够稳定验证本轮本地修复的主要前后端契约与失败处理逻辑。它仍不是“发布级的完整自动化测试体系”：尤其缺少可重复执行的真实 Tauri E2E、Mock IMAP 集成和 P0 安全回归。因此，在完成上述缺口及人工核查前，不应据此判断项目可以安全发布。

---

## 13. P2 优化执行记录（2026-08-01，本地未提交）

> 本节记录本轮在当前本地工作区完成的 P2 优化。未执行 `git commit`、`git push`、PR 创建或任何 GitHub 更新。

### 13.1 已完成的 P2 改动

| 问题 | 本轮处理 | 关键文件 |
|---|---|---|
| FE-04 / PERF-01 组件与首包过大 | 设置、历史、邮件面板改为 `React.lazy` + `Suspense`；文件解析改为按需加载；将 IMAP 目录解码从重量级解析器中拆出，避免动态导入被静态依赖抵消。 | `src/App.tsx`、`src/lib/parser.ts`、`src/lib/imapFolder.ts` |
| FE-05 Hook 陈旧闭包 | Zen 编辑器 handler 使用 `useCallback`；历史日期 effect 补齐 `selectedDate`；邮件审核键盘 effect 补齐筛选状态和 `toggleReviewed` 依赖。 | `src/components/ZenEditorModal.tsx`、`src/HistoryPanel.tsx`、`src/EmailTasksPanel.tsx` |
| FE-06 文件解析资源上限 | 新增 15 MB 单文件、5 文件/批次、PDF 最多 30 页、Excel 最多 10 个工作表/每表 2,000 行、解析结果最多 120,000 字符等限制；超限向用户返回明确提示；PDF worker 改为解析时动态加载。 | `src/lib/fileLimits.ts`、`src/lib/parser.ts`、`src/App.tsx` |
| BE-04 Rust 运行期 panic | 应用数据目录、历史路径、日志目录、窗口切换、托盘图标处理移除运行期 `unwrap()`，改为 `Result` 错误返回或错误日志；保留纯单元测试中的 `unwrap()`。 | `src-tauri/src/lib.rs` |
| QA-01 测试可信度 | 增加文件解析、IMAP 目录解码、E2E 配置类型检查；E2E 使用稳定 `data-testid`，不调用真实服务。 | `src/lib/parser.test.ts`、`src/lib/imapFolder.test.ts`、`test/e2e/tauri-driver.d.ts`、`test/e2e/main.spec.ts` |
| QA-02 CI 门禁 | `npm run lint` 改为真实执行 Oxlint；CI 不再使用 `|| true` 吞掉 lint 失败；加入 E2E TypeScript、Rust fmt、Clippy 和测试门禁。 | `package.json`、`.github/workflows/test.yml`、`tsconfig.e2e.json` |
| COMP-01 Notion 契约集中化 | 新增 Notion API adapter，集中管理 API 版本、页面/数据库端点、请求头和 ID 编码，并补充契约单测。 | `src/lib/notionApi.ts`、`src/lib/notionApi.test.ts`、`src/lib/notion.ts`、`src/SettingsPanel.tsx` |

### 13.2 P2 本地验证结果

| 命令 | 结果 |
|---|---:|
| `npm run lint` | 通过，无 Oxlint 告警 |
| `npm run test:e2e:types` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm test` | **12 个测试文件、32 个用例全部通过** |
| `npm run build` | 通过；主入口约 252 KB（gzip 约 81 KB），设置/历史/邮件面板和 PDF 解析已拆出独立 chunk |
| `cargo fmt -- --check` | 通过 |
| `cargo test` | **6 个用例全部通过** |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| `git diff --check` | 通过 |

构建仍有非阻断提示：PDF 解析 chunk 约 830 KB、PDF worker 约 1.25 MB，以及 Vite 的大 chunk 警告。这些属于后续进一步拆分/压缩事项，不影响本轮功能正确性验证。

### 13.3 尚未完全关闭的 P2 项

1. **FE-04 尚未完成大组件的全面领域拆分**：本轮已先完成懒加载、解析领域服务和目录解码拆分，但 `SettingsPanel.tsx`、`EmailTasksPanel.tsx` 和 `App.tsx` 仍然较大；后续应继续按容器、hooks、展示组件拆分。
2. **COMP-01 仅完成 adapter 第一阶段**：当前仍固定使用 `Notion-Version: 2022-06-28` 和 database API；尚未实现 data source 新模型兼容、能力探测和迁移策略。发布前需结合受控 Notion 测试数据库联调。
3. **真实桌面 E2E 尚未执行**：本机仍缺少 `tauri-driver`；虽然 E2E 已无真实凭据且配置可通过类型检查，但仍需在安装 Driver 的隔离环境实际运行。
4. **文件解析仍在前端线程执行**：本轮限制了输入规模并按需加载重型依赖，但尚未迁移到 Web Worker/Rust worker；复杂的 15 MB DOCX/XLSX/PDF 仍可能短时占用前端线程。
5. **P0 安全项仍未关闭**：邮件 HTML 消毒/CSP、本地密钥回退体系和历史 Git 记录清理仍需优先处理，不能因 P2 验证通过而视为可安全发布。

---

## 14. 前端与交互设计评估（2026-08-01，当前 dev 分支）

### 14.1 评估范围与方法

本次评估针对当前 `dev` 分支的 React/Tailwind/Tauri 前端，重点检查：

- 主任务流程：输入内容/图片/文件 → AI 提取 → 编辑待办 → Notion 同步；
- 设置、历史记录、邮件监听历史三个主要面板；
- 加载、错误、成功、空状态和破坏性操作反馈；
- 弹层、焦点、键盘、响应式和无障碍实现；
- 视觉层级、组件复用、首屏性能和交互测试可维护性。

本次为代码级交互审查，未把未安装 `tauri-driver` 的真实桌面 E2E 结果冒充为视觉验收结果。

### 14.2 当前设计优点

1. **核心任务路径较清晰**：主界面将输入区、文件/截图入口、`提取待办` 主按钮和结果区放在同一工作面板内，用户不需要在多个页面之间跳转。
2. **AI 结果具备可编辑性**：待办标题、优先级、日期和字段选择可以直接修改，并且同步成功后会锁定，避免用户误改已同步数据。
3. **邮件审核场景功能完整**：邮件历史支持目录/日期分组、待办与原文切换、图片预览、历史线程查看和逐条审核快捷键，业务深度较好。
4. **异步反馈基本覆盖**：主提取、邮件扫描、Notion 同步、复制结果和异常路径均有部分文字、颜色或 Toast 反馈；本轮已加入文件大小/数量限制和可见错误信息。
5. **性能方向已有改善**：设置、历史、邮件面板和解析器已经懒加载；PDF 解析依赖延迟加载，当前生产构建主入口约 252 KB（gzip 约 81 KB）。

### 14.3 主要问题与优化优先级

| 编号 | 优先级 | 发现 | 证据/影响 | 建议 |
|---|---|---|---|---|
| UX-01 | P1 | 无障碍语义不足 | 当前前端静态统计为 `aria-label` 0、`role` 0、`tabIndex` 仅 1；大量图标按钮依赖 `title`，不能稳定被屏幕阅读器识别。主界面上传图片缩略图 `src/App.tsx:522` 还缺少 `alt`。 | 为图标按钮补 `aria-label`；补齐图片替代文本；为状态消息使用 `aria-live`；为弹层、标签页、列表和菜单补语义角色；建立键盘导航和可见 focus 样式规范。 |
| UX-02 | P1 | 弹层缺少统一焦点管理 | 设置、历史和邮件面板使用固定定位容器，但没有统一 `role="dialog"`、`aria-modal`、焦点移入/恢复、焦点陷阱和 Escape 关闭策略；Zen 编辑器单独实现了一部分 Escape 行为，交互不一致。 | 抽取统一 `Dialog`/`Drawer` 容器，统一关闭按钮、Escape、点击遮罩、焦点陷阱、焦点恢复和滚动锁定。 |
| UX-03 | P1 | Tauri 自动隐藏行为可能造成误操作 | 非窗口模式下，外层容器 `src/App.tsx:446` 点击会隐藏窗口；窗口失焦也会自动隐藏。用户点击空白区域、切换到系统选择器或误触边缘时可能感觉界面突然消失。 | 将“隐藏窗口”作为明确的窗口行为而非普通页面点击副作用；增加首次使用提示和可配置选项；在有未保存输入、加载、确认弹窗或文件预览时禁止自动隐藏。 |
| UX-04 | P1 | 设置页信息架构过载 | `src/SettingsPanel.tsx` 约 91 KB，包含 AI、多 Provider、Notion、邮件、系统、日志、提示词优化等多个领域；保存按钮在底部，修改后关闭可能直接丢失草稿，且缺少“未保存变更”指示。 | 使用“基础设置 / 集成 / 邮件 / 高级”分组；增加侧边导航或步骤状态；显示 dirty 状态；关闭时提示保存/放弃；对 Provider、Notion、邮件配置提供分步向导和默认值。 |
| UX-05 | P1 | 邮件历史信息密度过高 | `src/EmailTasksPanel.tsx` 约 86 KB，目录日期侧栏、扫描状态日志、过滤器、审核模式、邮件详情、线程和图片预览全部叠加在一个面板内；窄屏下固定 `w-56` 侧栏和双栏结构容易挤压正文。 | 采用“列表 → 详情”的响应式两级导航；移动/窄窗口默认只显示列表，详情通过返回按钮进入；将扫描控制、审核过滤、日志折叠为独立工具栏；详情区固定标题和操作栏。 |
| UX-06 | P1 | 结果编辑和同步状态缺少可恢复路径 | 同步成功后显示“已同步至 Notion，禁止修改”，但用户无法在当前结果区查看同步页、解除未知状态或明确知道哪些字段被跳过；失败状态主要通过全局错误文本表达。 | 将每条待办增加同步状态、失败原因、重试/人工核对入口；成功状态显示页面链接或复制 ID；未知状态提供“已在 Notion 核对，允许重试”操作；避免整批结果只用一个全局错误。 |
| UX-07 | P2 | 状态反馈缺少统一组件 | 当前同时使用文本、颜色、渐变按钮、Toast、底部状态栏和日志面板；错误、成功、处理中、警告没有统一视觉和语义规范。Toast 也没有统一的 `aria-live`/关闭机制。 | 建立 `StatusBanner`、`Toast`、`Progress`、`EmptyState`、`ConfirmDialog` 基础组件；定义状态颜色、图标、文案、持续时间和可关闭规则；长任务显示阶段、进度、取消入口。 |
| UX-08 | P2 | 响应式覆盖不足 | 主界面有 `sm`/`md` 部分适配，但多个弹层仍使用固定高度和双栏布局，例如邮件面板约 `w-[95%] max-w-[940px] h-[85vh]`，侧栏固定 `w-56`；小窗口下可能出现横向拥挤、操作栏换行或按钮被遮挡。 | 以 320/375/768/1024px 四档检查；小于 768px 时切换为单栏；为长标题、按钮组和字段编辑定义换行规则；避免仅使用 `truncate` 隐藏关键内容。 |
| UX-09 | P2 | 视觉语言较丰富但缺少统一设计令牌 | 当前同时使用紫、粉、橙、青、绿、蓝等领域色，渐变、玻璃拟态、emoji 和 Lucide 图标混用；状态色可能被误解为业务含义，且大量 Tailwind class 内联在大组件中。 | 建立颜色/间距/圆角/阴影/字号 token；规定主行动、辅助行动、成功、警告、错误和信息色；统一图标风格，减少 emoji 与图标混用；将常用按钮、标签、卡片和分隔线抽成组件。 |
| UX-10 | P2 | 空状态和错误恢复不够任务导向 | 现有“暂无执行记录”“加载中…”等基础状态较简单；部分错误只显示技术性文本，缺少下一步动作。文件、AI、Notion、邮件错误应区分可重试、需改配置、需人工确认三类。 | 空状态增加说明、示例和主操作；错误消息提供“重试 / 打开设置 / 查看日志 / 复制诊断信息”；避免只展示异常字符串。 |
| UX-11 | P2 | 长列表和图片预览仍有潜在性能压力 | 邮件历史最多保留较多记录，详情包含线程、原文和图片；图片缩略图没有统一的懒加载/尺寸占位策略，主界面上传图片缩略图缺 `alt`，列表也未采用虚拟化。 | 图片使用 `loading="lazy"`、固定宽高和错误占位；邮件列表按需渲染；当记录量或线程长度超过阈值时采用虚拟列表或分段加载。 |
| UX-12 | P2 | 交互回归测试仍偏少 | 当前已有 12 个测试文件、32 个单测/集成用例，但组件层主要覆盖设置页基础渲染和快捷键 IPC，真实 Tauri E2E 仍因缺少 `tauri-driver` 未执行。 | 增加主提取流程、结果编辑、Notion 状态、设置未保存退出、弹层 Escape/焦点、邮件窄屏列表-详情切换和错误恢复测试；在 CI 安装 Driver 后执行无外部服务 E2E。 |

### 14.4 建议的交互重构目标

#### 阶段 A：先修复高风险可用性问题

1. 建立统一 Dialog 基础组件，补齐 `role`、`aria-modal`、焦点陷阱、Escape 和焦点恢复。
2. 为所有图标按钮补 `aria-label`，给上传图片、邮件图片和预览补 `alt`；引入 `aria-live` 状态区。
3. 增加设置草稿 dirty 状态和关闭确认，避免长表单修改丢失。
4. 将自动隐藏改为显式窗口策略，并在未保存/加载/弹窗状态下禁止隐藏。
5. 将 Notion 同步状态从简单锁定提示改成可追踪、可恢复的状态卡片。

#### 阶段 B：优化信息架构和响应式

1. 将主界面稳定为“输入工作台 → 结果工作台”的双阶段流程，减少结果区与输入区同时竞争注意力。
2. 将邮件历史重构为响应式列表-详情模式，扫描控制与审核控制分层。
3. 将设置页拆成可搜索的配置导航，按用户任务而非实现领域组织：模型、同步、邮件、外观与高级。
4. 建立基础设计系统组件，统一按钮、标签、Toast、确认框、空状态和进度条。

#### 阶段 C：性能与质量

1. 为邮件历史和图片预览增加懒加载、虚拟化和错误占位。
2. 将复杂 DOCX/XLSX/PDF 解析迁移到 Web Worker 或 Rust worker，避免阻塞界面。
3. 增加窄屏、键盘操作、未保存退出、失败重试和同步未知状态的组件/E2E 回归。
4. 在 CI 中完成 Tauri Driver 环境后执行桌面 E2E，并保留 mock 外部服务边界。

### 14.5 结论

当前前端已经具备较强的业务功能完整度，尤其是 AI 提取、待办编辑、邮件线程阅读和审核能力；主要问题不在“功能缺失”，而在**复杂功能堆积后的信息架构、弹层交互一致性、无障碍语义、状态可恢复性和窄屏适应性**。

建议优先处理 UX-01 至 UX-06，再处理视觉 token、响应式、长列表性能和测试补齐。完成阶段 A 后，用户对“窗口为什么消失”“设置是否保存”“同步失败能否恢复”“当前焦点在哪里”等关键问题的认知成本会明显下降。

## 15. 自定义 Provider Rust 代理优化记录（2026-08-01）

### 15.1 问题现象与原因

用户配置第三方大模型供应商时，直接请求自定义域名会触发 Tauri HTTP capability 的范围限制：

```text
连接失败: url not allowed on the configured scope: https://llm-wnbr8ptlsrxha0tp.cn-beijing.maas.aliyuncs.com/cp
```

根因是：内置供应商可以使用应用内显式 allowlist，但任意第三方供应商域名无法预先枚举；将 Tauri 全局范围放宽为 `https://**` 会扩大桌面应用网络访问面，不作为本项目的修复方案。

### 15.2 采用方案

本轮采用“自定义供应商 Rust 代理”方案：

- 内置供应商继续使用 Tauri HTTP plugin 和显式 allowlist；
- 自定义供应商统一调用前端 IPC 命令 `request_custom_llm`；
- Rust 端完成 URL 校验、DNS 解析、安全地址筛选、请求发送和响应大小限制；
- 前端继续沿用 OpenAI-compatible `/chat/completions` 请求及响应格式；
- 设置页连接测试、普通 AI 请求和 Prompt 优化请求共用同一套 Provider transport，避免入口之间行为不一致。

### 15.3 安全控制

自定义 Provider 代理当前包含以下限制：

- 仅允许 HTTPS；
- 禁止 URL 用户名和密码；
- 禁止 localhost、环回地址、链路本地地址、内网地址和云 metadata 类地址；
- 域名解析后必须选择公网地址，降低 DNS rebinding 风险；
- 禁止 HTTP 重定向；
- 连接超时 15 秒，总请求超时 30 秒；
- 请求体最大 5 MB，响应体最大 10 MB；
- 仅发送 Bearer API Key 和 JSON 请求体，不将 API Key 写入 URL；
- HTTP 4xx/5xx 继续交由前端按原有错误分类处理，便于展示配置错误和触发网络故障转移。

### 15.4 MaaS URL 兼容性

用户提供的地址：

```text
https://llm-wnbr8ptlsrxha0tp.cn-beijing.maas.aliyuncs.com/cp
```

会被规范化为：

```text
https://llm-wnbr8ptlsrxha0tp.cn-beijing.maas.aliyuncs.com/cp/chat/completions
```

若用户已经填写完整的 `/chat/completions` 路径，则不会重复拼接。该代理要求供应商提供 OpenAI-compatible Chat Completions 接口及兼容的 JSON 响应结构。

### 15.5 变更文件

- `src/lib/providerTransport.ts`：统一内置/自定义 Provider 请求传输；
- `src/lib/providerTransport.test.ts`：覆盖自定义 MaaS URL、endpoint 拼接、内置路径和超时错误；
- `src/lib/ai.ts`、`src/lib/http.ts`：接入统一 transport 和错误分类；
- `src/SettingsPanel.tsx`：Provider 连接测试改用统一 transport；
- `src-tauri/src/lib.rs`：新增 `request_custom_llm` IPC 命令及 URL/公网地址校验；
- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`：加入 `reqwest` 和 `url` 依赖。

### 15.6 自动化验证结果

| 检查项 | 结果 |
|---|---:|
| `cargo fmt -- --check` | 通过 |
| `cargo test` | **7 个用例全部通过** |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| 前端 `npm run lint` | 已通过 |
| 前端 `npx tsc --noEmit` | 已通过 |
| 前端 `npm test` | **13 个测试文件、36 个用例全部通过** |
| 前端 `npm run build` | 已通过 |

上述测试均未使用真实 API Key，也未对真实第三方供应商发起请求；当前仍需在用户自己的环境中使用真实供应商配置完成联调核查。

### 15.7 发布前核查建议

1. 在开发环境填写真实供应商 Base URL、模型名和 API Key，确认连接测试能够通过。
2. 分别验证填写 `/cp`、`/v1` 以及完整 `/chat/completions` 路径时的最终请求地址。
3. 验证供应商返回 401、403、429、5xx 和超时时，界面提示与故障转移行为符合预期。
4. 确认供应商证书、DNS 和网络出口满足 HTTPS 与公网地址校验要求。
5. 不要通过恢复 Tauri 全局 `https://**` 来绕过 capability 限制。
6. 本轮仅完成本地代码修改和验证，未自动提交或推送 GitHub；待用户完成核查后再手动提交/推送。

## 16. Notion 推送与自动演进业务逻辑评估（2026-08-01，修改前）

### 16.1 评估范围与结论

本节仅评估当前 `dev` 分支中 Notion 推送、手动/邮件入口、自动邮件同步及 Prompt 自动演进的业务逻辑；**未修改相关业务代码，未提交或推送 GitHub**。

当前实现已经具备字段序列化、单进程串行推送、基于本地记录的创建幂等保护、网络不确定结果保护及基础历史学习能力。但它实际表达的是“**从本地待办创建 Notion 页面，并尽量避免同一次创建重复执行**”，而不是“**持续同步并更新同一条 Notion 任务**”。推送状态、用户决策状态、自动演进状态目前被少量布尔字段复用，已出现事实含义冲突。

**结论：不建议在现有状态字段和事件时序上直接增加 Notion 推送功能。** 应先确认“修改后推送”究竟是更新原 Page 还是创建新 Page，并先完成状态模型与历史样本边界的调整；否则会带来重复建页、错误学习、未知状态无法恢复和 UI 状态失真的风险。

### 16.2 当前端到端业务流

1. **AI 提取**：手动提取后，`App.tsx` 为整次结果生成随机 `result.id`，并立即把 AI 初始结果写入手动历史；AI 结果中的 `originalTodos` 由提取函数复制初始待办快照。
2. **手动 Notion 推送**：主界面过滤“已勾选且未标记 `synced`”的待办，调用 `syncToNotion`；成功项仅写回 `todo.synced = true`，所有项成功时写 `result.syncedToNotion = true`。
3. **邮件页面手动推送**：逻辑与主界面相似，成功项写回 `todo.synced = true`，整封邮件只有全部成功才设 `syncedToNotion = true`。
4. **邮件自动推送**：调度器在开启 `autoSyncToNotion` 时，提取待办后直接创建 Notion Page；任何一项失败都会使该邮件处理进入重试/失败路径。
5. **Notion 创建与幂等**：`syncToNotion` 使用模块级队列串行逐条 POST `/v1/pages`。本地记录以 `databaseId:todo.id` 为键、以请求 body 的 SHA-256 为指纹：同指纹成功则跳过；网络异常、429、408、5xx 或成功响应缺 Page ID 则进入 `unknown`，后续同指纹自动重试被阻止。
6. **自动演进**：用户同步时会后台调用 `backgroundReviewAndUpdateFocus(originalTodos, selectedTodos)`；用户填写负反馈时会调用 `backgroundReviewAndUpdateFocus(originalTodos, [], feedback)`。自动演进直接让模型生成新关注点，并立即覆盖 `autoOptimizedFocus`。
7. **历史分析演进**：`analyzeHistoryAndUpdateFocus` 取手动历史全部记录，以及 `syncedToNotion === true` 的邮件历史作为样本，生成新提示词后自动切换到 `promptMode = 'auto'`。

### 16.3 关键问题与风险分级

| 编号 | 等级 | 发现 | 业务影响 |
|---|---|---|---|
| NAE-01 | **P1** | 同步成功后只保存局部 `synced` / 整体 `syncedToNotion`，没有把 `SyncResult.pageId` 回写为待办的持久关联。再次编辑后仍只能 POST 创建 Page，不能 PATCH 既有 Page。 | 用户修改已推送待办后再次推送，极可能在 Notion 中生成第二页；“推送”与“同步更新”的产品预期不一致。 |
| NAE-02 | **P1** | 手动和邮件入口均在同步结果判定后，把 `selectedTodos`（而不是 `succeeded` 对应待办）交给自动演进；部分失败、`unknown`、字段校验失败的项会被当成“认可并最终同步”的正样本。 | 技术故障会污染用户偏好学习，后续提取规则可能朝错误方向演进。 |
| NAE-03 | **P1** | 邮件负反馈完成后把 `syncedToNotion` 设为 `true`，仅为了把界面折叠为“已处理”。而历史分析把该字段视为“邮件自动同步成功”的入样条件。 | 被用户拒绝的邮件会被伪装成 Notion 已推送的正向样本，正负反馈语义倒置。 |
| NAE-04 | **P1** | `backgroundReviewAndUpdateFocus` 吞掉所有异常且无返回状态；调用方却在 await 返回后写 `feedbackStatus = completed`。静态模式、无变化、模型失败、保存失败均可能显示为“已学习”。 | 用户被误导；无法诊断自动演进是否真正执行，历史审计也不可靠。 |
| NAE-05 | **P1** | `unknown` 状态能避免网络不确定时重复建页，但没有“人工核对成功”“确认未创建后重试”“强制解除”的界面和状态迁移。 | 用户遇到超时/429/5xx 后会被永久式阻断同指纹重试，只能绕过或改内容，容易造成重复页或任务遗漏。 |
| NAE-06 | **P1** | 幂等键依赖本地 `todo.id`；本地提取/复制/重新提取没有业务稳定 ID 的约束。 | 内容相同但本地 ID 改变时，幂等保护失效，跨会话或重新提取后可能重复创建页面。 |
| NAE-07 | **P2** | 推送字段定位通过 `notionProperties.find(property.name === todoKey)`；虽然映射以 `notionPropId` 存储，却未将属性 ID 作为同步 payload 的主关联键。 | 字段重命名、大小写、展示名变动或 AI 输出键偏差会导致字段静默丢失或无法同步；映射配置的稳定性不足。 |
| NAE-08 | **P2** | `ai.ts` 与 `autoOptimize.ts` 各自构造 Notion schema 描述，且自动演进描述未完整覆盖 `status`、`relation`、`url`、`email`、`phone_number` 等推送能力。 | AI 提取、自动学习与实际序列化规则存在漂移，可能生成无法推送的字段值。 |
| NAE-09 | **P2** | 历史深度分析对手动历史基本全量取样，未排除 `isRejected`、`feedbackStatus: processing`、未确认或未同步的初始 AI 结果；同时会自动切换到 `promptMode = auto`。 | 单次未确认结果也可能进入长期偏好；模式被静默切换，用户失去对规则变更的控制。 |
| NAE-10 | **P2** | 自动邮件同步只要有一项同步失败就让整封邮件进入重试路径；与 Notion `unknown` 的“禁止自动重试”组合后，重试会反复得到阻断结果。 | 邮件任务可能长期失败或反复告警，已成功的子项与待核对/失败子项没有明确的后续处理队列。 |
| NAE-11 | **P2** | 自动演进直接覆盖全局关注点，无版本、差异预览、样本来源、最小样本阈值、回滚或用户确认。 | 一次负反馈、异常样本或提示注入式内容可能影响后续所有提取，且难以追溯和恢复。 |

### 16.4 现有实现中值得保留的能力

- `syncToNotion` 通过队列串行处理，减少了多入口并发创建导致的本地记录竞争。
- 对 4xx 配置/校验错误删除 pending 记录、允许用户修正后再同步；对网络不确定结果保留 `unknown`，避免盲目自动重发造成重复建页。
- 序列化层已覆盖 title、文本、选择、多选、日期、复选、数字、URL、邮箱、电话与 relation 等多种字段类型，并会对 select/status/multi-select 的枚举值做校验。
- 成功项已经能够逐条写回 `todo.synced`，为后续演进为“单待办的显式同步状态”提供了基础。

### 16.5 修改前必须确认的产品决策

以下决策会直接决定数据结构、API 调用方式和迁移路径，建议先由产品/用户确认：

1. **修改后再次推送的语义**：推荐默认采用“已有关联 Page ID 则 PATCH 更新该 Page；没有 Page ID 才创建”的 upsert 策略。若希望保留历史版本，应明确提供“另存为新页面”而非让普通推送隐式重复创建。
2. **用户认可与远端同步是否拆分**：推荐拆分。用户勾选/确认是偏好学习事件；Notion 成功是交付状态事件。自动演进不应把网络故障当成用户偏好。
3. **部分成功策略**：推荐在界面中逐条展示成功、可重试失败、待人工核对；学习样本默认只使用用户确认的最终内容，并记录远端交付结果，而不是只依赖“整批是否成功”。
4. **`unknown` 人工处理策略**：至少提供“打开/搜索 Notion 核对”“确认已创建并绑定 Page ID”“确认未创建后解除锁定并重试”三条路径；强制重试应二次确认。
5. **自动演进应用方式**：推荐从“模型直接覆盖”改为“生成候选版本 → 展示变更摘要与样本来源 → 用户应用/忽略/回滚”。只有用户明确开启的全自动模式才可自动应用，并保留版本记录。
6. **隐私边界**：历史摘要、待办、邮件文本和显式反馈会传给当前配置的 AI Provider。应在开启自动演进前明确展示数据范围，并允许用户选择样本来源和关闭邮件参与学习。

### 16.6 建议的目标状态模型

避免继续复用 `synced`、`syncedToNotion`、`isRejected` 和 `feedbackStatus` 表示多种概念。建议在待办和结果层引入独立状态：

```ts
type UserDecision = 'draft' | 'selected' | 'rejected' | 'edited' | 'approved'
type NotionSyncStatus =
  | 'not_requested'
  | 'pending'
  | 'succeeded'
  | 'failed_retryable'
  | 'unknown_requires_review'
  | 'skipped_duplicate'
type EvolutionStatus =
  | 'not_eligible'
  | 'queued'
  | 'applied'
  | 'unchanged'
  | 'failed'
```

每个待办建议保存以下最小信息：

```ts
{
  id,                    // 本地稳定 UUID
  sourceId,              // 手动提取 / 邮件 UID 等来源标识
  originalSnapshot,      // AI 初始输出
  currentSnapshot,       // 用户编辑后的最终值
  userDecision,
  notion: {
    status: NotionSyncStatus,
    pageId?: string,
    fingerprint?: string,
    lastError?: string,
    updatedAt?: number
  }
}
```

结果/历史层应单独保存 `evolution` 记录（状态、候选版本 ID、输入样本 ID、错误、时间），不再用 `syncedToNotion` 代表“已处理”。已有历史数据需要提供向后兼容迁移：旧 `todo.synced === true` 可初始化为 `notion.status = 'succeeded'`，但因没有 pageId，必须标记为“旧记录未绑定 Page，不能安全执行更新”，由用户选择重新绑定或另建。

### 16.7 推荐改造顺序

1. **先修正状态语义（P1）**：移除“负反馈后写 `syncedToNotion = true`”；让自动演进返回结构化结果，不再吞异常；UI 依据真实执行结果显示 applied/unchanged/failed。
2. **修正学习事件边界（P1）**：同步入口把 `succeeded` 对应的条目、用户最终编辑快照和明确反馈分别传入学习模块；禁止把 `unknown`、失败和处理中的历史作为正样本。
3. **引入 Page 关联与更新能力（P1）**：持久化 pageId；新增 `PATCH /v1/pages/{page_id}`；把“创建/更新/跳过/待核对”逐条反馈到 UI 与历史。
4. **完善未知结果处置（P1）**：实现人工核对状态机和恢复入口，避免用户靠修改内容绕过幂等锁。
5. **统一 Schema adapter（P2）**：以 Notion 属性 ID 为稳定主键，抽取单一 schema 序列化/AI 描述模块，让 AI 类型约束和 API payload 共用同一事实来源。
6. **把自动演进改为可审计候选（P2）**：增加版本、diff、来源和回滚；历史批量分析只选择明确确认的最终样本，并不得隐式切换模式。
7. **最后处理邮件自动化（P2）**：按待办状态继续处理，不因一个子项失败重复整封邮件；明确已成功、失败可重试、unknown 待人工核对三类后续动作。

### 16.8 修改后的验收用例（应先补自动化测试）

- 同一待办首次创建成功后，保存 Page ID；用户修改标题/日期再次推送应调用 PATCH，且 Notion 中页面数量不增加。
- 未改内容重复推送应返回 `skipped_duplicate`，不发网络请求。
- 批量推送部分成功时：成功项标记 `succeeded` 并保存 Page ID，失败项保持可重试状态，unknown 项进入人工核对；三者在 UI 可区分。
- 网络超时后的 `unknown` 可由人工“确认已创建并绑定 Page ID”或“确认未创建后重试”恢复，且不会隐式重复建页。
- 邮件负反馈完成后，`notion.status` 仍为 `not_requested`，不得写成“已推送”；该记录不得进入邮件正向同步学习样本。
- 自动演进在静态模式、无变化、模型异常、持久化异常、真正应用时分别返回不同状态；UI 不得把失败显示为完成。
- 自动演进收到部分同步结果时，不把失败/unknown 作为“远端成功”样本；编辑过但保留同一 ID 的待办可识别为编辑样本。
- 历史批量分析只使用已确认的最终快照；拒绝、处理中、未确认记录和技术失败记录均不进入正向学习。
- 字段在 Notion 中重命名后，依旧可凭属性 ID 构造正确 payload；AI schema 描述与 serializer 支持的字段类型保持一致。

### 16.9 修改前的最终建议

本次 Notion 推送项调整应按“**状态模型 → 事件边界 → Page 关联与更新 → 人工核对 → 自动演进治理**”的顺序实施。若直接在现有 `synced`/`syncedToNotion` 之上增加按钮或重试逻辑，只会掩盖重复建页与错误学习问题，后续迁移成本更高。
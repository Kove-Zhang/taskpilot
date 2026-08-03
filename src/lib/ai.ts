import { useSettingsStore, getSortedLLMProviders, getEffectiveFocus, type LLMProvider } from '../store'
import { HttpRequestError, isRetryableHttpStatus, isRetryableTransportError } from './http'
import { logger } from './logger'
import { requestProviderChatCompletion } from './providerTransport'
import type { FeedbackType } from './feedbackAvailability'

export interface AIResult {
  id?: string;
  summary: string;
  key_points?: string[];
  todos: TodoItem[];
  originalTodos?: TodoItem[];
  syncedToNotion?: boolean;
  feedbackStatus?: 'processing' | 'completed';
  explicitFeedback?: string;
  feedbackType?: FeedbackType;
  isRejected?: boolean;
}

export interface TodoItem {
  id: string;
  title: string;
  priority: 'High' | 'Medium' | 'Low' | string;
  planned_date: string | null;
  selected?: boolean;
  [key: string]: any;
}

type ChatMessageContent = string | Array<Record<string, unknown>>

interface ChatCompletionPayload {
  model: string
  messages: Array<{ role: string; content: ChatMessageContent }>
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getCompletionContent(data: unknown, providerName: string): string {
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0 || !isRecord(data.choices[0])) {
    throw new Error(`服务商 [${providerName}] 返回数据结构异常：缺少 choices[0]`)
  }

  const message = data.choices[0].message
  if (!isRecord(message) || typeof message.content !== 'string' || !message.content.trim()) {
    throw new Error(`服务商 [${providerName}] 返回数据结构异常：缺少有效 message.content`)
  }

  return message.content
}

const TODO_TITLE_FIELD_ALIASES = ['title', 'task', 'content', 'name', 'text', 'description']
const TODO_ID_FIELD_ALIASES = ['id', 'task_id', 'todo_id', 'uuid']

function getNonEmptyText(value: unknown, allowNumber = false): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (allowNumber && typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function findTextField(
  value: Record<string, unknown>,
  fieldNames: readonly string[],
  allowNumber = false,
): { fieldName: string; value: string } | null {
  for (const fieldName of fieldNames) {
    const text = getNonEmptyText(value[fieldName], allowNumber)
    if (text) return { fieldName, value: text }
  }
  return null
}

function getConfiguredTodoTitleFields(): string[] {
  const { notionProperties, fieldMappings } = useSettingsStore.getState()
  return notionProperties
    .filter((property) => property.type === 'title' && fieldMappings[property.id]?.enabled)
    .map((property) => property.name)
}

/** Creates a stable local ID when a compatible provider omits its optional model-generated ID. */
function createFallbackTodoId(rawContent: string, index: number, title: string): string {
  const input = `${rawContent}\u0000${index}\u0000${title}`
  let hash = 2_166_136_261
  for (let position = 0; position < input.length; position += 1) {
    hash ^= input.charCodeAt(position)
    hash = Math.imul(hash, 16_777_619)
  }
  return `generated-${index + 1}-${(hash >>> 0).toString(36)}`
}

function getSafeFieldNames(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort().slice(0, 30) : []
}

function sanitizePayloadForLog(payload: ChatCompletionPayload): Record<string, unknown> {
  return {
    ...payload,
    messages: payload.messages.map((message) => ({
      role: message.role,
      content: Array.isArray(message.content)
        ? message.content.map((item) => ({
            type: item.type,
            text: item.type === 'text' ? `[Text length: ${String(item.text ?? '').length}]` : undefined,
            image_url: item.type === 'image_url' ? '[Base64 Image Data omitted]' : undefined,
          }))
        : `[Text length: ${message.content.length}]`,
    })),
  }
}

function formatProviderError(providerName: string, status: number, body: string): HttpRequestError {
  const compactBody = body.replace(/\s+/g, ' ').slice(0, 1_000)
  return new HttpRequestError(`API 请求失败 [${providerName}] (${status}): ${compactBody}`, { status })
}

function waitBeforeRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 1_000 * attempt))
}

/**
 * 清洗并压缩长文本，节约 Token。
 */
function compressTextForAI(text: string, maxLength: number = 8000): string {
  if (!text) return ''
  let optimized = text.replace(/\n\s*\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (optimized.length > maxLength) {
    optimized = optimized.substring(0, maxLength) + '\n\n...(注：为防止 Token 溢出与历史旧任务干扰，超出阈值的尾部历史转发记录已自动精简。提炼待办和要点时请将 100% 重心放在顶部的【最新核心正文】中！)'
  }
  return optimized
}

/**
 * 带超时、重试与多供应商轮换的 AI 调用核心引擎。
 * 仅网络错误、超时、408、429 与 5xx 会重试或切换服务商，避免将同一内容发送给多个服务商处理配置类 4xx 错误。
 */
export async function callAIWithFailover(
  buildPayload: (provider: LLMProvider) => ChatCompletionPayload,
  logContextName: string,
): Promise<string> {
  const { enableFailover, failoverRetryCount, failoverOnAuthError, apiBaseUrl, apiKey, modelName } = useSettingsStore.getState()
  let providers = getSortedLLMProviders().filter((provider) => provider.enabled)

  if (providers.length === 0 || providers.every((provider) => !provider.apiKey.trim())) {
    if (!apiKey.trim()) {
      throw new Error('请先在设置中配置 API Key')
    }
    providers = [{
      id: 'legacy',
      name: '默认服务商',
      apiBaseUrl,
      apiKey,
      modelName,
      enabled: true,
      priority: 1,
    }]
  }

  const maxRetriesPerProvider = Math.max(1, failoverRetryCount || 1)
  let lastRetryableError: Error | null = null

  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex]
    if (!provider.apiKey.trim()) {
      logger.warn(`服务商 [${provider.name}] 未配置 API Key，跳过。`)
      continue
    }

    if (!provider.apiBaseUrl.trim()) {
      throw new Error(`服务商 [${provider.name}] 未配置 API Base URL`)
    }
    const payload = buildPayload(provider)

    for (let attempt = 1; attempt <= maxRetriesPerProvider; attempt += 1) {
      try {
        logger.info(
          `[${logContextName}] 发起调用 -> 服务商: [${provider.name}] (模型: ${provider.modelName}, 尝试 ${attempt}/${maxRetriesPerProvider})`,
          { payload: sanitizePayloadForLog(payload) },
        )

        const response = await requestProviderChatCompletion({
          baseUrl: provider.apiBaseUrl,
          apiKey: provider.apiKey,
          payload,
        })

        if (!response.ok) {
          const error = formatProviderError(provider.name, response.status, await response.text())
          if (!isRetryableHttpStatus(response.status)) {
            throw error
          }
          lastRetryableError = error
          logger.warn(error.message)
        } else {
          let responseData: unknown
          try {
            responseData = await response.json()
          } catch {
            throw new HttpRequestError(`服务商 [${provider.name}] 返回的成功响应不是有效 JSON`, {
              isRetryable: true,
            })
          }
          const content = getCompletionContent(responseData, provider.name)
          logger.info(`[${logContextName}] 成功收到回复 <- 服务商: [${provider.name}]`, { contentLength: content.length })
          return content
        }
      } catch (error) {
        const isAuthenticationFailure = error instanceof HttpRequestError && error.status === 401
        const shouldFailoverOnAuthenticationFailure = enableFailover && failoverOnAuthError && isAuthenticationFailure

        if (isAuthenticationFailure && !shouldFailoverOnAuthenticationFailure) {
          throw error
        }
        if (error instanceof HttpRequestError && error.status !== undefined && !isRetryableHttpStatus(error.status) && !shouldFailoverOnAuthenticationFailure) {
          throw error
        }
        if (!shouldFailoverOnAuthenticationFailure && !isRetryableTransportError(error) && !(error instanceof HttpRequestError && error.status !== undefined)) {
          throw error instanceof Error ? error : new Error(String(error))
        }
        lastRetryableError = error instanceof Error ? error : new Error(String(error))

        if (shouldFailoverOnAuthenticationFailure) {
          logger.warn(`[${logContextName}] 服务商 [${provider.name}] 认证失败（401），已启用认证失败备用服务商策略，将直接轮换。`)
          break
        }

        logger.warn(`[${logContextName}] 可重试调用失败 -> 服务商: [${provider.name}] (尝试 ${attempt}/${maxRetriesPerProvider}): ${lastRetryableError.message}`)
      }

      if (attempt < maxRetriesPerProvider) {
        await waitBeforeRetry(attempt)
      }
    }

    if (!enableFailover) {
      break
    }
    if (providerIndex < providers.length - 1) {
      logger.info(`触发大模型自动故障转移，顺位轮换至下一服务商: [${providers[providerIndex + 1].name}]...`)
    }
  }

  throw lastRetryableError || new Error('所有大模型服务商均调用失败，请检查网络或 API 配置。')
}

function normalizeExtractionResult(rawContent: string): AIResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch (error) {
    logger.error('Failed to parse AI response', { rawLength: rawContent.length, error })
    throw new Error('AI 返回的格式无法解析为 JSON')
  }

  if (!isRecord(parsed) || typeof parsed.summary !== 'string' || !Array.isArray(parsed.todos)) {
    logger.warn('AI 返回提取结果字段不兼容', {
      topLevelFields: getSafeFieldNames(parsed),
      hasStringSummary: isRecord(parsed) && typeof parsed.summary === 'string',
      hasTodosArray: isRecord(parsed) && Array.isArray(parsed.todos),
    })
    throw new Error('AI 返回的 JSON 缺少 summary 或 todos 字段')
  }

  const titleFieldNames = [...new Set([...TODO_TITLE_FIELD_ALIASES, ...getConfiguredTodoTitleFields()])]
  const todos = parsed.todos.map((todo, index) => {
    if (!isRecord(todo)) {
      logger.warn('AI 返回的待办无法规范化', { index: index + 1, receivedType: Array.isArray(todo) ? 'array' : typeof todo })
      throw new Error(`AI 返回的第 ${index + 1} 条待办不是对象`)
    }

    const title = findTextField(todo, titleFieldNames)
    if (!title) {
      logger.warn('AI 返回的待办缺少可识别标题字段', {
        index: index + 1,
        fieldNames: getSafeFieldNames(todo),
      })
      throw new Error(`AI 返回的第 ${index + 1} 条待办缺少有效 title`)
    }

    const modelId = findTextField(todo, TODO_ID_FIELD_ALIASES, true)
    const id = modelId?.value || createFallbackTodoId(rawContent, index, title.value)
    if (title.fieldName !== 'title' || !modelId || modelId.fieldName !== 'id') {
      logger.warn('AI 返回的待办已按兼容规则规范化', {
        index: index + 1,
        originalFieldNames: getSafeFieldNames(todo),
        titleSource: title.fieldName,
        idSource: modelId?.fieldName || 'generated',
      })
    }

    return { ...todo, id, title: title.value, selected: true } as TodoItem
  })

  const keyPoints = Array.isArray(parsed.key_points)
    ? parsed.key_points.filter((item): item is string => typeof item === 'string')
    : undefined

  return {
    summary: parsed.summary,
    key_points: keyPoints,
    todos,
    originalTodos: structuredClone(todos),
  }
}

export async function extractTodosFromContent(textContent: string, base64Images: string[]): Promise<AIResult> {
  const { notionProperties, fieldMappings, tokenLimit, enableReasoning } = useSettingsStore.getState();
  const personalFocus = getEffectiveFocus();

  const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled) || [];
  
  const todoSchemaLines = [
    '"id": "待办唯一 ID（非空字符串，同一次输出内不可重复）"',
    '"title": "待办事项标题（非空字符串）"',
    '"priority": "★ 或者 ★★ 或者 ★★★"',
    '"planned_date": "YYYY-MM-DD 格式的日期；无明确日期时为 null"',
  ]
  const requiredTodoKeys = new Set(['id', 'title', 'priority', 'planned_date'])
  let hintDesc = "";

  for (const field of activeFields) {
    const mapping = fieldMappings[field.id];
    let typeDesc = "字符串";
    if (field.type === 'date') typeDesc = "YYYY-MM-DD格式的日期，如无明确日期则留空";
    if (field.type === 'checkbox') typeDesc = "布尔值(true/false)";
    if (field.type === 'number') typeDesc = "数字";
    if (field.type === 'select' || field.type === 'multi_select') {
      typeDesc = `只能是以下枚举值之一: [${field.options?.join(', ') || ''}]`;
    }

    if (!requiredTodoKeys.has(field.name)) {
      todoSchemaLines.push(`${JSON.stringify(field.name)}: ${JSON.stringify(typeDesc)}`)
    }
    if (mapping?.aiHint) {
      hintDesc += `- "${field.name}": ${mapping.aiHint}\n`;
    }
  }

  const jsonSchemaDesc = `{\n      ${todoSchemaLines.join(',\n      ')}\n    }`;

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const textLen = textContent ? textContent.length : 0;
  const imgCount = base64Images.length;
  const isComplex = textLen > 3000 || imgCount >= 2;
  const isMedium = !isComplex && (textLen >= 500 || imgCount === 1);

  let summaryDesc = "对内容的简短总结（100字以内）";
  let keyPointsSchema = "";
  let keyPointsHint = "";

  if (isComplex) {
    summaryDesc = "对内容的多维深度结构化概括（300-600字），详细陈述事件脉络、业务背景与前置依赖";
    keyPointsSchema = `,\n  "key_points": ["核心要点/结论1", "核心要点/结论2", "核心要点/结论3"]`;
    keyPointsHint = "\n请务必在 key_points 数组中分条提炼出3-5个最核心的背景结论或决策依赖要点。";
  } else if (isMedium) {
    summaryDesc = "对内容的结构化概述（200-300字），分层概括核心背景、诉求与行动要求";
  }

  const systemPrompt = `你是一个智能助理，任务是从用户输入的内容中提取核心总结和待办事项。
当前系统真实时间是：${timeStr} (请以此为基准推算“明天”、“下周”等相对时间名词的精确日期，必须转换为 YYYY-MM-DD 格式，绝不可臆想错乱的时间)。

用户的个人关注重点是：${personalFocus}
请结合用户的关注重点进行分析。

请以严格的 JSON 格式输出，不要包含 Markdown 代码块标记（如 \`\`\`json ）。输出格式如下：
{
  "summary": "${summaryDesc}"${keyPointsSchema},
  "todos": [
    ${jsonSchemaDesc}
  ]
}
如果没有待办事项，todos 数组留空。${keyPointsHint}

【输出契约（必须遵守）】
- todos 数组中的每一项都必须同时包含字面量字段 "id" 和 "title"，且二者均为非空字符串。
- "id" 只用于本地唯一标识，可使用 "todo-1"、"todo-2" 等；同一次输出内不得重复。
- 即使同时输出 Notion 动态字段，也不得用 task、content、name 或 Notion 字段名替代 "title"。
- planned_date 无明确日期时必须输出 null，不得输出空字符串。
${hintDesc ? `\n【针对特定字段的提取约束】\n${hintDesc}` : ''}`;

  const contentArray: any[] = [];
  if (textContent) {
    const compressed = compressTextForAI(textContent, tokenLimit || 8000);
    contentArray.push({ type: "text", text: compressed });
  }
  
  for (const img of base64Images) {
    contentArray.push({
      type: "image_url",
      image_url: { url: img }
    });
  }

  if (!enableReasoning) {
    contentArray.push({ 
      type: "text", 
      text: "\n\n(指令：请直接输出最终结果，跳过所有思维链、推导过程和思考步骤。)\n/no_think" 
    });
  }

  const rawContent = await callAIWithFailover((provider) => {
    const model = provider.modelName || "gpt-4o";
    const payload: any = {
      model: model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentArray }
      ]
    };

    const isOSeries = /^o\d+/.test(model.toLowerCase());
    const isClaude = model.toLowerCase().includes('claude');
    const isDeepSeek = model.toLowerCase().includes('deepseek') || model.toLowerCase().includes('reasoner') || model.toLowerCase().includes('thinking');

    if (!enableReasoning) {
      if (isOSeries) {
        payload.reasoning_effort = "low";
      } else if (isClaude) {
        payload.thinking = { type: "disabled" };
      } else if (isDeepSeek) {
        payload.reasoning_effort = "low";
      }
    } else {
      if (isOSeries) {
        payload.reasoning_effort = "high";
      } else if (isClaude) {
        payload.thinking = { type: "enabled", budget_tokens: 4096 };
      }
    }
    return payload;
  }, "提取待办");
  
  return normalizeExtractionResult(rawContent)
}

export async function generateWriting(
  intent: string, 
  contextTodos: TodoItem[],
  originalText?: string,
  originalImages?: string[]
): Promise<string> {
  const { enableReasoning } = useSettingsStore.getState();

  const systemPrompt = `你是一个高级AI撰写助手。你的任务是根据用户提供的【待办事项上下文】和【撰写意图】，生成结构清晰、语气恰当的长文本（如邮件、报告等）。
请直接输出生成的文本内容，不要输出任何多余的解释说明。`;

  // 动态提取并紧凑压缩
  const compressedTodos = contextTodos.map((t, i) => {
    const props = Object.entries(t)
        .filter(([k, v]) => k !== 'id' && k !== 'selected' && !!v)
        .map(([k, v]) => `${k}:${v}`)
        .join('; ');
    return `[待办${i+1}] ${props}`;
  }).join('\n');

  const contentArray: any[] = [];
  if (originalText) {
    const optimizedText = compressTextForAI(originalText, 3000);
    contentArray.push({ type: "text", text: "【参考材料】\n" + optimizedText });
  }
  
  for (const img of (originalImages || [])) {
    contentArray.push({ type: "image_url", image_url: { url: img } });
  }
  
  contentArray.push({ 
    type: "text", 
    text: `\n【已有待办】\n${compressedTodos}\n\n【用户意图】\n${intent}\n\n请根据以上信息开始撰写：` 
  });

  if (!enableReasoning) {
    contentArray.push({ 
      type: "text", 
      text: "\n\n(指令：请直接输出最终结果，跳过所有思维链、推导过程和思考步骤。)\n/no_think" 
    });
  }

  const rawContent = await callAIWithFailover((provider) => {
    const model = provider.modelName || "gpt-4o";
    const payload: any = {
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentArray }
      ]
    };

    const isOSeries = /^o\d+/.test(model.toLowerCase());
    const isClaude = model.toLowerCase().includes('claude');
    const isDeepSeek = model.toLowerCase().includes('deepseek') || model.toLowerCase().includes('reasoner') || model.toLowerCase().includes('thinking');

    if (!enableReasoning) {
      if (isOSeries) {
        payload.reasoning_effort = "low";
      } else if (isClaude) {
        payload.thinking = { type: "disabled" };
      } else if (isDeepSeek) {
        payload.reasoning_effort = "low";
      }
    } else {
      if (isOSeries) {
        payload.reasoning_effort = "high";
      } else if (isClaude) {
        payload.thinking = { type: "enabled", budget_tokens: 4096 };
      }
    }
    return payload;
  }, "内容撰写");

  return rawContent;
}

import { useSettingsStore, getSortedLLMProviders, getEffectiveFocus, type LLMProvider } from '../store'
import { fetch } from '@tauri-apps/plugin-http';
import { logger } from './logger';

export interface AIResult {
  id?: string;
  summary: string;
  key_points?: string[];
  todos: TodoItem[];
  originalTodos?: TodoItem[]; // For auto memory optimization diff
  syncedToNotion?: boolean;
  feedbackStatus?: 'processing' | 'completed';
  explicitFeedback?: string;
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

/**
 * 清洗并压缩长文本，节约 Token
 * @param text 原始文本
 * @param maxLength 安全截断阈值
 */
function compressTextForAI(text: string, maxLength: number = 8000): string {
  if (!text) return "";
  // 替换多个连续空行/换行为单换行，替换连续空格为单空格，去除首尾空白
  let optimized = text.replace(/\n\s*\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  // 超过阈值则截断
  if (optimized.length > maxLength) {
    optimized = optimized.substring(0, maxLength) + '\n\n...(注：为防止 Token 溢出与历史旧任务干扰，超出阈值的尾部历史转发记录已自动精简。提炼待办和要点时请将 100% 重心放在顶部的【最新核心正文】中！)';
  }
  return optimized;
}

/**
 * 带多供应商轮换与重试机制的 AI 调用核心引擎
 */
export async function callAIWithFailover(
  buildPayload: (provider: LLMProvider) => any,
  logContextName: string
): Promise<string> {
  const { enableFailover, failoverRetryCount, apiBaseUrl, apiKey, modelName } = useSettingsStore.getState();
  let providers = getSortedLLMProviders().filter(p => p.enabled);

  // 若提供商列表为空或均无可用的 API Key，尝试回退到传统的单节点设置
  if (providers.length === 0 || providers.every(p => !p.apiKey || !p.apiKey.trim())) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error("请先在设置中配置 API Key");
    }
    providers = [{
      id: 'legacy',
      name: '默认服务商',
      apiBaseUrl,
      apiKey,
      modelName,
      enabled: true,
      priority: 1
    }];
  }

  const maxRetriesPerProvider = Math.max(1, failoverRetryCount || 1);
  let lastError: Error | null = null;

  for (let pIndex = 0; pIndex < providers.length; pIndex++) {
    const provider = providers[pIndex];
    if (!provider.apiKey) {
      logger.warn(`服务商 [${provider.name}] 未配置 API Key，跳过。`);
      continue;
    }

    const payload = buildPayload(provider);
    const normalizedUrl = provider.apiBaseUrl.endsWith('/') ? provider.apiBaseUrl.slice(0, -1) : provider.apiBaseUrl;
    const endpoint = `${normalizedUrl}/chat/completions`;

    // 对当前服务商进行最大 maxRetriesPerProvider 次尝试
    for (let attempt = 1; attempt <= maxRetriesPerProvider; attempt++) {
      try {
        const logPayload = { ...payload };
        if (logPayload.messages) {
          logPayload.messages = logPayload.messages.map((m: any) => {
            if (m.role === 'user' && Array.isArray(m.content)) {
              return {
                role: m.role,
                content: m.content.map((c: any) => ({
                  type: c.type,
                  text: c.type === 'text' ? `[Text length: ${c.text?.length}]` : undefined,
                  image_url: c.type === 'image_url' ? '[Base64 Image Data omitted]' : undefined
                }))
              };
            }
            return m;
          });
        }

        logger.info(`[${logContextName}] 发起调用 -> 服务商: [${provider.name}] (模型: ${provider.modelName}, 尝试 ${attempt}/${maxRetriesPerProvider})`, { payload: logPayload });
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await response.text();
          const status = response.status;
          // 判断是否为限流或服务端异常（429, 500+），或者是未达到单个供应商最大重试次数
          const isRateLimitOrServerErr = status === 429 || status >= 500;
          const errMsg = `API 请求失败 [${provider.name}] (${status}): ${errText}`;
          if (isRateLimitOrServerErr || attempt < maxRetriesPerProvider) {
            logger.warn(errMsg);
            lastError = new Error(errMsg);
            if (attempt < maxRetriesPerProvider) {
              await new Promise(r => setTimeout(r, 1000 * attempt)); // 指数退避重试
              continue; // 继续重试当前供应商
            }
          } else {
            lastError = new Error(errMsg);
            break; // 中断当前供应商重试，转入下一个供应商
          }
        } else {
          const data = await response.json();
          logger.info(`[${logContextName}] 成功收到回复 <- 服务商: [${provider.name}]`, { response: data });
          if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error(`服务商 [${provider.name}] 返回数据结构异常: ${JSON.stringify(data)}`);
          }
          return data.choices[0].message.content;
        }
      } catch (err: any) {
        logger.warn(`[${logContextName}] 呼叫异常 -> 服务商: [${provider.name}] (尝试 ${attempt}/${maxRetriesPerProvider}): ${err.message || err}`);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetriesPerProvider) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    // 若当前供应商所有重试均失败，检查是否允许轮换
    if (!enableFailover) {
      logger.warn(`未开启异常自动轮换，终止调用。`);
      break;
    }
    if (pIndex < providers.length - 1) {
      logger.info(`触发大模型自动故障转移，顺位轮换至下一服务商: [${providers[pIndex + 1].name}]...`);
    }
  }

  throw lastError || new Error("所有大模型服务商均调用失败，请检查网络或 API 配置。");
}

export async function extractTodosFromContent(textContent: string, base64Images: string[]): Promise<AIResult> {
  const { notionProperties, fieldMappings, tokenLimit, enableReasoning } = useSettingsStore.getState();
  const personalFocus = getEffectiveFocus();

  const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled) || [];
  
  let jsonSchemaDesc = `{\n      "id": "唯一随机ID",\n`;
  let hintDesc = "";

  if (activeFields.length === 0) {
    jsonSchemaDesc += `      "title": "待办事项标题",\n      "priority": "★ 或者 ★★ 或者 ★★★",\n      "planned_date": "YYYY-MM-DD格式的日期，如无明确日期则留空"\n`;
  } else {
    for (const field of activeFields) {
      const mapping = fieldMappings[field.id];
      let typeDesc = "字符串";
      if (field.type === 'date') typeDesc = "YYYY-MM-DD格式的日期，如无明确日期则留空";
      if (field.type === 'checkbox') typeDesc = "布尔值(true/false)";
      if (field.type === 'number') typeDesc = "数字";
      if (field.type === 'select' || field.type === 'multi_select') {
        typeDesc = `只能是以下枚举值之一: [${field.options?.join(', ') || ''}]`;
      }
      
      jsonSchemaDesc += `      "${field.name}": "${typeDesc}",\n`;
      if (mapping?.aiHint) {
        hintDesc += `- "${field.name}": ${mapping.aiHint}\n`;
      }
    }
  }
  jsonSchemaDesc += `    }`;

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
  
  try {
    const parsedResult = JSON.parse(rawContent) as AIResult;
    if (!parsedResult.todos || !Array.isArray(parsedResult.todos)) {
      parsedResult.todos = [];
    }
    if (!parsedResult.key_points || !Array.isArray(parsedResult.key_points)) {
      parsedResult.key_points = undefined;
    }
    parsedResult.todos = parsedResult.todos.map(t => ({ 
      ...t, 
      selected: true
    }));
    return {
      summary: parsedResult.summary,
      key_points: parsedResult.key_points,
      todos: parsedResult.todos,
      originalTodos: JSON.parse(JSON.stringify(parsedResult.todos))
    };
  } catch (err) {
    logger.error('Failed to parse AI response', { rawContent, error: err });
    throw new Error('AI 返回的格式无法解析为 JSON');
  }
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

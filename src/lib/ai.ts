import { useSettingsStore } from '../store'
import { fetch } from '@tauri-apps/plugin-http';
import { logger } from './logger';

export interface AIResult {
  id?: string;
  summary: string;
  todos: TodoItem[];
  syncedToNotion?: boolean;
}

export interface TodoItem {
  id: string;
  selected?: boolean;
  [key: string]: any;
}

export async function extractTodosFromContent(textContent: string, base64Images: string[]): Promise<AIResult> {
  const { apiBaseUrl, apiKey, modelName, personalFocus, notionProperties, fieldMappings } = useSettingsStore.getState();

  if (!apiKey) {
    throw new Error("请先在设置中配置 API Key");
  }

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

  const systemPrompt = `你是一个智能助理，任务是从用户输入的内容中提取核心总结和待办事项。
当前系统真实时间是：${timeStr} (请以此为基准推算“明天”、“下周”等相对时间名词的精确日期，必须转换为 YYYY-MM-DD 格式，绝不可臆想错乱的时间)。

用户的个人关注重点是：${personalFocus}
请结合用户的关注重点进行分析。

请以严格的 JSON 格式输出，不要包含 Markdown 代码块标记（如 \`\`\`json ）。输出格式如下：
{
  "summary": "对内容的简短总结（100字以内）",
  "todos": [
    ${jsonSchemaDesc}
  ]
}
如果没有待办事项，todos 数组留空。
${hintDesc ? `\n【针对特定字段的提取约束】\n${hintDesc}` : ''}`;

  const contentArray: any[] = [];
  if (textContent) {
    contentArray.push({ type: "text", text: textContent });
  }
  
  for (const img of base64Images) {
    contentArray.push({
      type: "image_url",
      image_url: { url: img }
    });
  }

  const payload = {
    model: modelName || "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: contentArray }
    ]
  };

  logger.info('Sending extraction prompt to AI', { systemPrompt, inputCount: contentArray.length });

  const normalizedUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  const response = await fetch(`${normalizedUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${err}`);
  }

  const data = await response.json();
  logger.info('Received extraction response from AI', { response: data });
  const rawContent = data.choices[0].message.content;
  
  try {
    const parsed = JSON.parse(rawContent) as AIResult;
    if (parsed.todos) {
      const today = new Date().toISOString().split('T')[0];
      parsed.todos = parsed.todos.map(t => ({ 
        ...t, 
        selected: true,
        planned_date: t.planned_date || today
      }));
    }
    return parsed;
  } catch (e) {
    throw new Error("模型返回的数据无法解析为 JSON: " + rawContent);
  }
}

export async function generateWriting(intent: string, contextTodos: TodoItem[]): Promise<string> {
  const { apiBaseUrl, apiKey, modelName } = useSettingsStore.getState();

  if (!apiKey) {
    throw new Error("请先在设置中配置 API Key");
  }

  const systemPrompt = `你是一个高级AI撰写助手。你的任务是根据用户提供的【待办事项上下文】和【撰写意图】，生成结构清晰、语气恰当的长文本（如邮件、报告等）。
请直接输出生成的文本内容，不要输出任何多余的解释说明。`;

  const contextStr = contextTodos.map(t => `- [${t.priority}] ${t.title}`).join('\n');
  const userContent = `【待办事项上下文】：\n${contextStr}\n\n【撰写意图】：\n${intent}\n\n请根据以上信息开始撰写：`;

  const payload = {
    model: modelName || "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ]
  };

  logger.info('Sending writing prompt to AI', { systemPrompt, userContent });

  const normalizedUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  const response = await fetch(`${normalizedUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${err}`);
  }

  const data = await response.json();
  logger.info('Received writing response from AI', { response: data });
  return data.choices[0].message.content;
}

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
  title: string;
  priority: string;
  planned_date?: string;
  selected?: boolean;
}

export async function extractTodosFromContent(textContent: string, base64Images: string[]): Promise<AIResult> {
  const { apiBaseUrl, apiKey, modelName, personalFocus } = useSettingsStore.getState();

  if (!apiKey) {
    throw new Error("请先在设置中配置 API Key");
  }

  const systemPrompt = `你是一个智能助理，任务是从用户输入的内容中提取核心总结和待办事项。
用户的个人关注重点是：${personalFocus}
请结合用户的关注重点进行分析。

请以严格的 JSON 格式输出，不要包含 Markdown 代码块标记（如 \`\`\`json ）。输出格式如下：
{
  "summary": "对内容的简短总结（100字以内）",
  "todos": [
    {
      "id": "唯一随机ID",
      "title": "待办事项标题",
      "priority": "★" 或者 "★★" 或者 "★★★",
      "planned_date": "YYYY-MM-DD格式的日期，如无明确日期则留空"
    }
  ]
}
如果没有待办事项，todos 数组留空。`;

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

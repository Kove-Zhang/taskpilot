import { useSettingsStore, getEffectiveFocus } from '../store';
import type { TodoItem } from './ai';
import { callAIWithFailover } from './ai';
import { logger } from './logger';
import { invoke } from '@tauri-apps/api/core';

function buildNotionSchemaDescription(): string {
  const { notionProperties, fieldMappings } = useSettingsStore.getState();
  const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled) || [];
  
  if (activeFields.length === 0) {
    return '  - title: 待办事项标题\n  - priority: 优先级\n  - planned_date: 计划日期';
  }

  let desc = '';
  for (const field of activeFields) {
    const mapping = fieldMappings[field.id];
    let typeDesc = "字符串";
    if (field.type === 'date') typeDesc = "YYYY-MM-DD 格式日期";
    if (field.type === 'checkbox') typeDesc = "布尔值(true/false)";
    if (field.type === 'number') typeDesc = "数字";
    if (field.type === 'select' || field.type === 'multi_select') {
      typeDesc = `枚举值之一: [${field.options?.join(', ') || ''}]`;
    }
    desc += `  - ${field.name}: ${typeDesc}${mapping?.aiHint ? ` (提示: ${mapping.aiHint})` : ''}\n`;
  }
  return desc;
}

export async function backgroundReviewAndUpdateFocus(
  aiResult: TodoItem[], 
  finalResult: TodoItem[]
) {
  try {
    const state = useSettingsStore.getState();
    if (state.promptMode !== 'auto') {
      return;
    }

    const aiStr = JSON.stringify(aiResult);
    const finalStr = JSON.stringify(finalResult);
    if (aiStr === finalStr) {
      logger.info("[AutoOptimize] 无修改，跳过更新记忆。");
      return;
    }

    const notionSchema = buildNotionSchemaDescription();
    const currentFocus = getEffectiveFocus();

    const systemPrompt = `你是一个后台自我迭代与 Prompt 工程师助手。
您的任务是分析用户对历史提取任务的修改痕迹，进而自动演进和更新全局的【任务提取关注点提示词】。

【当前已配置的 Notion 数据结构】
${notionSchema}

【当前系统的任务提取提示词】
${currentFocus}

【AI 初次提取结果】
${aiStr}

【用户最终修改后的结果】
${finalStr}

【约束与护栏规则】
1. 请分析用户的修改行为。如果发现了持久且强烈的规则偏好（例如：用户总是删除某种特定类型的待办、总是修改默认优先级、总是补全某个特定字段），请归纳并输出一段**改进后的纯文本提示词**。
2. 切勿因用户单次的特殊修改（如某一次性的网络环境错误导致的数据缺失，或临时增加的某个随机待办）而颠覆全局规则。只有在你有把握这是用户的工作流偏好时，才输出新的提示词。
3. 如果你认为用户的修改只是偶发事件，不构成长期偏好，或者当前的提示词已经足够好，请只输出保留原样的提示词，或输出 null。
4. 绝对不可输出任何关于 JSON 格式、Markdown 标记的内容，只需输出纯文本规则和偏好。不要任何开场白或解释。`;

    const rawContent = await callAIWithFailover((provider) => {
      const model = provider.modelName || "gpt-4o-mini";
      const payload: any = {
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "请输出更新后的关注点提示词(若无需修改请输出与原版相同的文本):" }
        ]
      };
      
      const isOSeries = /^o\d+/.test(model.toLowerCase());
      const isClaude = model.toLowerCase().includes('claude');
      const isDeepSeek = model.toLowerCase().includes('deepseek') || model.toLowerCase().includes('reasoner') || model.toLowerCase().includes('thinking');

      // 背景任务强制低推理以省流
      if (isOSeries) {
        payload.reasoning_effort = "low";
      } else if (isClaude) {
        payload.thinking = { type: "disabled" };
      } else if (isDeepSeek) {
        payload.reasoning_effort = "low";
      }
      return payload;
    }, "后台记忆更新");

    const newFocus = rawContent.trim();
    if (newFocus && newFocus !== 'null' && newFocus !== currentFocus) {
      useSettingsStore.getState().setAutoOptimizedFocus(newFocus);
      logger.info("[AutoOptimize] 自动记忆更新成功", { old: currentFocus, new: newFocus });
    }
  } catch (err) {
    logger.warn("[AutoOptimize] 自动更新失败", err);
  }
}

export async function analyzeHistoryAndUpdateFocus() {
  let dataJson;
  try {
    dataJson = await invoke<string>("load_history");
  } catch (err: any) {
    const errorStr = typeof err === 'string' ? err : (err.message || String(err));
    if (errorStr.includes("aead::Error")) {
      throw new Error("安全密钥变更导致历史记录解密失败。请在主界面提取并保存一条新任务以重置加密文件，随后即可重试。");
    }
    throw new Error(errorStr);
  }
  const data = JSON.parse(dataJson || "[]");
  
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("没有历史记录可供分析。");
  }

  // Pick top 20 or less
  const records = data.slice(0, 20).map((r: any) => ({
    summary: r.result?.summary,
    key_points: r.result?.key_points,
    final_todos: r.result?.todos
  }));

  let recordsJson = JSON.stringify(records, null, 2);
  if (recordsJson.length > 15000) {
    recordsJson = recordsJson.substring(0, 15000) + "\n...[为防止 Token 溢出，部分过长历史记录已被安全截断]";
  }

  const notionSchema = buildNotionSchemaDescription();
  const currentFocus = getEffectiveFocus();

  const systemPrompt = `你是一个后台自我迭代与 Prompt 工程师助手。
您的任务是基于老用户过去 ${records.length} 次任务提取历史，分析其工作流习惯，生成或更新全局的【任务提取关注点提示词】。

【当前已配置的 Notion 数据结构】
${notionSchema}

【当前系统的任务提取提示词】
${currentFocus}

【历史记录摘要样本】
${recordsJson}

【约束与护栏规则】
1. 上述历史记录是我们对用户过去任务提取的极度浓缩（仅包含大意摘要与最终定稿的待办事项）。
2. 请分析这些记录中待办事项的共性，例如：用户通常关注什么级别的事情？哪类信息被提取为哪种特定优先级？
3. 归纳这些持久的工作流偏好，输出一段**全新的、结构清晰的纯文本指令（提示词）**。
4. 这段提示词将被用来指导另一个大模型在未来的任务提取中更懂用户。
5. 绝对不可输出任何关于 JSON 格式、Markdown 标记的内容，只需输出纯文本规则和偏好。不要任何开场白或解释。`;

  const rawContent = await callAIWithFailover((provider) => {
    const model = provider.modelName || "gpt-4o";
    const payload: any = {
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "请输出分析历史后深度优化出的全新关注点提示词:" }
      ]
    };
    return payload;
  }, "历史记录深度分析");

  const newFocus = rawContent.trim();
  if (newFocus && newFocus !== 'null') {
    useSettingsStore.getState().setAutoOptimizedFocus(newFocus);
    useSettingsStore.getState().setPromptMode('auto');
    return newFocus;
  }
  
  throw new Error("模型未返回有效提示词");
}

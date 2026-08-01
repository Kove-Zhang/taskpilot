import { useSettingsStore, getEffectiveFocus } from '../store';
import type { TodoItem } from './ai';
import { callAIWithFailover } from './ai';
import { logger } from './logger';
import { loadHistory } from './history';
import { LazyStore } from '@tauri-apps/plugin-store';

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
  originalResult: TodoItem[], 
  acceptedResult: TodoItem[],
  explicitFeedback?: string
) {
  try {
    const state = useSettingsStore.getState();
    if (state.promptMode !== 'auto') {
      return;
    }

    const aiStr = JSON.stringify(originalResult);
    const finalStr = JSON.stringify(acceptedResult);
    if (aiStr === finalStr && !explicitFeedback) {
      logger.info("[AutoOptimize] 无修改，跳过更新记忆。");
      return;
    }

    const notionSchema = buildNotionSchemaDescription();
    const currentFocus = getEffectiveFocus();

    const rejectedResult = originalResult.filter(
      orig => !acceptedResult.find(acc => acc.id === orig.id)
    );

    const systemPrompt = `你是一个后台自我迭代与 Prompt 工程师助手。
您的任务是分析用户对历史提取任务的修改痕迹（特别是负向反馈），进而自动演进和更新全局的【任务提取关注点提示词】。

【当前已配置的 Notion 数据结构】
${notionSchema}

【当前系统的任务提取提示词】
${currentFocus}

【用户认可并最终勾选同步的待办】
${JSON.stringify(acceptedResult)}

【被用户明确拒绝/取消勾选的待办 (反面教材)】
${JSON.stringify(rejectedResult)}

${explicitFeedback ? `【来自用户的强显式纠正指令】\n${explicitFeedback}\n` : ''}
【约束与护栏规则】
1. 请分析用户的正向和负向修改行为。特别是被拒绝的反面教材，请总结为何它们不该被提取。如果有用户的显式指令，必须将其视为最高优先级的核心规则。
2. 归纳并输出一段**改进后的纯文本提示词**。如果发现了持久且强烈的规则偏好（例如：用户总是删除某种特定类型的待办、用户明确指示不提取某类信息），请务必在新的提示词中添加明确的禁止性约束（如“绝对不要提取...”）。
3. 切勿因用户单次的特殊修改而颠覆全局基本规则，但用户的显式指令必须服从。
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
    
    // Always dispatch if we have explicit feedback, to confirm it was processed
    const isUpdated = newFocus && newFocus !== 'null' && newFocus !== currentFocus;
    
    if (isUpdated) {
      useSettingsStore.getState().setAutoOptimizedFocus(newFocus);
      logger.info("[AutoOptimize] 自动记忆更新成功", { old: currentFocus, new: newFocus });
      window.dispatchEvent(new CustomEvent('ai-evolution-completed', { 
        detail: { 
          title: "🧠 AI 认知已自我演进",
          message: explicitFeedback ? "系统已根据您的纠正指令，深度学习并更新了全局提取规则。" : "系统深度学习了您最近的操作偏好，全局提取规则已更新完毕。" 
        } 
      }));
    } else if (explicitFeedback) {
      // If user explicitly provided feedback but AI decided not to change the prompt
      logger.info("[AutoOptimize] 自动记忆未更新 (已有规则覆盖或无效纠正)", { newFocus });
      window.dispatchEvent(new CustomEvent('ai-evolution-completed', { 
        detail: { 
          title: "🧠 AI 深度反思完毕",
          message: "系统认为当前核心规则已能完全覆盖您的诉求，本次未对底层规则做大改。" 
        } 
      }));
    }
  } catch (err) {
    logger.warn("[AutoOptimize] 自动更新失败", err);
  }
}

export async function analyzeHistoryAndUpdateFocus() {
  let data;
  try {
    data = await loadHistory();
  } catch (err: any) {
    const errorStr = typeof err === 'string' ? err : (err.message || String(err));
    if (errorStr.includes("aead::Error")) {
      throw new Error("安全密钥变更导致历史记录解密失败。请在主界面提取并保存一条新任务以重置加密文件，随后即可重试。");
    }
    throw new Error(errorStr);
  }
  
  const emailHistoryStore = new LazyStore('email_history.enc');
  const emailData: any[] = await emailHistoryStore.get('history') || [];

  if ((!Array.isArray(data) || data.length === 0) && emailData.filter(r => r.syncedToNotion === true).length === 0) {
    throw new Error("没有有效的历史记录可供分析。");
  }

  const manualRecords = Array.isArray(data) ? data.map((r: any) => ({
    source: "手动输入提取",
    timestamp: new Date(r.timestamp).getTime() || 0,
    summary: r.result?.summary,
    key_points: r.result?.key_points,
    final_todos: r.result?.todos
  })) : [];

  const emailRecords = emailData.filter(r => r.syncedToNotion === true).map((r: any) => ({
    source: "邮件自动同步",
    timestamp: r.timestamp || 0,
    summary: r.aiResult?.summary,
    key_points: r.aiResult?.key_points,
    final_todos: r.aiResult?.todos
  }));

  const records = [...manualRecords, ...emailRecords]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 30)
    .map(r => ({
      source: r.source,
      summary: r.summary,
      key_points: r.key_points,
      final_todos: r.final_todos
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

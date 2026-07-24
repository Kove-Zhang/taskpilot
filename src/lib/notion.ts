import { useSettingsStore } from '../store';
import { fetch } from '@tauri-apps/plugin-http';
import type { TodoItem } from './ai';

export interface SyncResult {
  id: string;
  success: boolean;
  error?: string;
}

export async function syncToNotion(todos: TodoItem[]): Promise<SyncResult[]> {
  const { notionApiKey, notionDatabaseId, notionProperties } = useSettingsStore.getState();

  if (!notionApiKey || !notionDatabaseId) {
    throw new Error("请先在设置中配置 Notion API Key 和 Database ID");
  }

  const results: SyncResult[] = [];

  for (const todo of todos) {
    if (!todo.id) continue;

    try {
      const pageBody = {
        parent: { type: "database_id", database_id: notionDatabaseId },
        properties: {}
      } as any;

      for (const [key, value] of Object.entries(todo)) {
        if (key === 'id' || key === 'selected') continue;
        if (value === undefined || value === null || value === "") continue;

        // Find the corresponding Notion property definition by name
        const prop = notionProperties?.find(p => p.name === key);
        
        // Fallback: If no schema is synced yet, try to guess the standard ones
        if (!prop) {
          if (key === 'title' || key === 'Name') {
             pageBody.properties[key] = { title: [{ text: { content: String(value) } }] };
          } else if (key === 'priority' || key === '优先级') {
             pageBody.properties[key] = { select: { name: String(value) } };
          } else if (key === 'planned_date' || key === '计划完成时间') {
             const dateStr = String(value).replace(/\//g, '-').substring(0, 10);
             pageBody.properties[key] = { date: { start: dateStr } };
          }
          continue;
        }

        switch (prop.type) {
          case 'title':
            pageBody.properties[key] = { title: [{ text: { content: String(value) } }] };
            break;
          case 'rich_text':
            pageBody.properties[key] = { rich_text: [{ text: { content: String(value) } }] };
            break;
          case 'select':
            const selVal = String(value).trim();
            if (prop.options && prop.options.length > 0 && !prop.options.includes(selVal)) {
              // Option not in Notion schema, drop it to prevent 400 error
              break;
            }
            pageBody.properties[key] = { select: { name: selVal } };
            break;
          case 'multi_select':
            const names = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim());
            const validNames = prop.options && prop.options.length > 0
              ? names.filter(n => prop.options!.includes(n))
              : names;
            if (validNames.length > 0) {
              pageBody.properties[key] = { multi_select: validNames.map(n => ({ name: n })) };
            }
            break;
          case 'date':
            // Normalize date to ISO format YYYY-MM-DD
            let dateStr = String(value).replace(/\//g, '-').substring(0, 10);
            pageBody.properties[key] = { date: { start: dateStr } };
            break;
          case 'checkbox':
            pageBody.properties[key] = { checkbox: value === true || String(value).toLowerCase() === 'true' };
            break;
          case 'number':
            const num = Number(value);
            if (!isNaN(num)) {
              pageBody.properties[key] = { number: num };
            }
            break;
          case 'url':
            pageBody.properties[key] = { url: String(value) };
            break;
          case 'email':
            pageBody.properties[key] = { email: String(value) };
            break;
          case 'phone_number':
            pageBody.properties[key] = { phone_number: String(value) };
            break;
        }
      }

      const response = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${notionApiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(pageBody)
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(err);
      }

      results.push({ id: todo.id, success: true });
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      results.push({ id: todo.id, success: false, error: msg });
    }
  }

  return results;
}

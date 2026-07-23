import { useSettingsStore } from '../store';
import { fetch } from '@tauri-apps/plugin-http';
import type { TodoItem } from './ai';

export async function syncToNotion(todos: TodoItem[]): Promise<void> {
  const { notionApiKey, notionDatabaseId, notionProperties } = useSettingsStore.getState();

  if (!notionApiKey || !notionDatabaseId) {
    throw new Error("请先在设置中配置 Notion API Key 和 Database ID");
  }

  for (const todo of todos) {
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
           pageBody.properties[key] = { date: { start: String(value) } };
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
          pageBody.properties[key] = { select: { name: String(value) } };
          break;
        case 'multi_select':
          const names = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim());
          pageBody.properties[key] = { multi_select: names.map(n => ({ name: n })) };
          break;
        case 'date':
          pageBody.properties[key] = { date: { start: String(value) } };
          break;
        case 'checkbox':
          pageBody.properties[key] = { checkbox: value === true || String(value).toLowerCase() === 'true' };
          break;
        case 'number':
          pageBody.properties[key] = { number: Number(value) };
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
      throw new Error(`Notion 同步失败: ${err}`);
    }
  }
}

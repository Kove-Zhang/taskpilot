import { useSettingsStore } from '../store';
import { fetch } from '@tauri-apps/plugin-http';
import type { TodoItem } from './ai';

export async function syncToNotion(todos: TodoItem[]): Promise<void> {
  const { notionApiKey, notionDatabaseId } = useSettingsStore.getState();

  if (!notionApiKey || !notionDatabaseId) {
    throw new Error("请先在设置中配置 Notion API Key 和 Database ID");
  }

  for (const todo of todos) {
    const pageBody = {
      parent: { type: "database_id", database_id: notionDatabaseId },
      properties: {
        "Name": {
          title: [{ text: { content: todo.title } }]
        },
        "优先级": {
          select: { name: todo.priority || "★" }
        },
        "完成": {
          checkbox: false
        }
      }
    } as any;

    if (todo.planned_date) {
      pageBody.properties["计划完成时间"] = {
        date: { start: todo.planned_date }
      };
    }

    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionApiKey}`,
        "Notion-Version": "2025-09-03",
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

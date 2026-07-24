import { useState, useEffect } from 'react'
import { X, Clock, Trash2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { AIResult } from './lib/ai'
import { useSettingsStore } from './store'

interface HistoryEntry {
  timestamp: string;
  result: AIResult;
  input?: string;
  images?: string[];
}

interface HistoryPanelProps {
  onClose: () => void;
  onRestore: (result: AIResult, input?: string, images?: string[]) => void;
}

export default function HistoryPanel({ onClose, onRestore }: HistoryPanelProps) {
  const { notionProperties, fieldMappings } = useSettingsStore();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingIdx, setConfirmingIdx] = useState<number | null>(null);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    try {
      const dataJson = await invoke<string>("load_history");
      const data = JSON.parse(dataJson || "[]") as HistoryEntry[];
      setHistory(data);
    } catch (e) {
      console.error("加载历史记录失败", e);
    } finally {
      setLoading(false);
    }
  }

  const clearHistory = async () => {
    try {
      await invoke("save_history", { data: "[]" });
      setHistory([]);
    } catch (e) {
      console.error("清空历史记录失败", e);
    }
  }

  const deleteHistoryItem = async (indexToDelete: number) => {
    try {
      const newHistory = history.filter((_, idx) => idx !== indexToDelete);
      await invoke("save_history", { data: JSON.stringify(newHistory) });
      setHistory(newHistory);
    } catch (e) {
      console.error("删除单个历史记录失败", e);
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="glass-panel w-full max-w-xl p-6 flex flex-col gap-4 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 h-[80vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-3 shrink-0">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-400" />
            历史提取记录
          </h2>
          <div className="flex items-center gap-3">
            <button onClick={clearHistory} className="text-xs flex items-center gap-1 text-slate-400 hover:text-red-400 transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> 清空
            </button>
            <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-md transition-colors text-slate-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar flex flex-col gap-4">
          {loading ? (
            <div className="text-center text-slate-500 py-10">加载中...</div>
          ) : history.length === 0 ? (
            <div className="text-center text-slate-500 py-10">暂无历史记录</div>
          ) : (
            history.map((entry, idx) => (
              <div 
                key={idx} 
                onDoubleClick={() => setConfirmingIdx(idx)}
                className="bg-slate-900/50 p-4 rounded-lg border border-white/5 relative group cursor-pointer hover:border-purple-500/50 transition-colors"
                title="双击恢复此记录"
              >
                {entry.result.syncedToNotion && (
                  <div className="absolute top-4 right-12 text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded border border-green-500/30">
                    已推送
                  </div>
                )}
                <button 
                  onClick={() => deleteHistoryItem(idx)}
                  className="absolute top-4 right-4 p-1 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded opacity-0 group-hover:opacity-100 transition-all"
                  title="删除此记录"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <div className="text-xs text-slate-500 mb-2 pr-8">{new Date(entry.timestamp).toLocaleString()}</div>
                <div className="text-sm text-slate-300 mb-3 line-clamp-2">{entry.result.summary}</div>
                <div className="space-y-1.5">
                  {entry.result.todos.map((t: any, i) => {
                    const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled) || [];
                    const titleProp = activeFields.find(p => p.type === 'title')?.name || 'title';
                    const priorityProp = activeFields.find(p => p.name.includes('优先') || p.name === 'priority' || p.type === 'select')?.name || 'priority';
                    
                    return (
                      <div key={i} className="text-xs text-slate-400 flex items-center gap-2">
                        {t[priorityProp] && <span className="text-purple-400">[{t[priorityProp]}]</span>}
                        <span>{t[titleProp] || t.title || t.Name || '未命名待办'}</span>
                      </div>
                    )
                  })}
                  {entry.result.todos.length === 0 && <div className="text-xs text-slate-500">无待办事项</div>}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Custom Confirm Modal */}
        {confirmingIdx !== null && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/60 rounded-xl backdrop-blur-sm">
            <div className="bg-slate-800 border border-slate-700 p-6 rounded-lg max-w-sm w-full shadow-2xl flex flex-col gap-4">
              <h3 className="text-lg font-medium text-white">确认恢复历史记录</h3>
              <p className="text-sm text-slate-300">
                确定要用这条历史记录覆盖当前工作区吗？
                {history[confirmingIdx]?.result?.syncedToNotion && (
                  <span className="block mt-3 text-amber-400 p-2 bg-amber-500/10 rounded border border-amber-500/20">
                    ⚠️ 注意：该记录已被推送至 Notion。<br/>禁止修改已同步的待办，以避免数据重复推送！
                  </span>
                )}
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <button 
                  onClick={() => setConfirmingIdx(null)}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-white transition-colors"
                >
                  取消
                </button>
                <button 
                  onClick={() => {
                    const entry = history[confirmingIdx];
                    onRestore(entry.result, entry.input, entry.images);
                    setConfirmingIdx(null);
                    onClose();
                  }}
                  className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded transition-colors"
                >
                  确认恢复
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

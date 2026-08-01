import { useState, useEffect, useMemo } from 'react'
import { X, Clock, Trash2, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { AIResult } from './lib/ai'
import { loadHistory, updateHistory, type HistoryEntry } from './lib/history'
import { useSettingsStore, useUIStore } from './store'

interface HistoryPanelProps {
  onClose: () => void;
  onRestore: (result: AIResult, input?: string, images?: string[]) => void;
}

export default function HistoryPanel({ onClose, onRestore }: HistoryPanelProps) {
  const { notionProperties, fieldMappings, isWindowMode } = useSettingsStore();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingIdx, setConfirmingIdx] = useState<number | null>(null);
  const [expandedTodos, setExpandedTodos] = useState<Record<string, boolean>>({});
  const { historySelectedDate, setHistorySelectedDate } = useUIStore();
  const [selectedDate, setSelectedDate] = useState<string | null>(historySelectedDate);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    message: string;
    onConfirm: () => void;
  }>({ isOpen: false, message: '', onConfirm: () => {} });

  useEffect(() => {
    setHistorySelectedDate(selectedDate);
  }, [selectedDate, setHistorySelectedDate]);

  const { grouped, dates } = useMemo(() => {
    const indexedHistory = history.map((item, originalIndex) => ({ ...item, originalIndex }));
    const sorted = [...indexedHistory].sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeB - timeA;
    });

    const g: Record<string, typeof sorted> = {};
    sorted.forEach(item => {
      const dateObj = new Date(item.timestamp);
      const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
      
      if (!g[dateStr]) g[dateStr] = [];
      g[dateStr].push(item);
    });

    const d = Object.keys(g).sort((a, b) => b.localeCompare(a));
    return { grouped: g, dates: d };
  }, [history]);

  useEffect(() => {
    if (dates.length === 0) {
      setSelectedDate(null);
      return;
    }
    if (selectedDate && grouped[selectedDate]) {
      return;
    }
    setSelectedDate(dates[0]);
  }, [grouped, dates, selectedDate]);

  const toggleExpand = (key: string) => {
    setExpandedTodos(prev => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    void refreshHistory();
  }, []);

  const refreshHistory = async () => {
    try {
      setHistory(await loadHistory());
    } catch (error) {
      console.error('加载历史记录失败', error);
    } finally {
      setLoading(false);
    }
  }

  const clearHistory = async () => {
    setConfirmDialog({
      isOpen: true,
      message: '确定要清空所有手动提取记录吗？此操作不可恢复。',
      onConfirm: async () => {
        try {
          setHistory(await updateHistory(() => []));
        } catch (error) {
          console.error('清空历史记录失败', error);
        }
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
      }
    });
  }

  const deleteHistoryItem = async (indexToDelete: number) => {
    setConfirmDialog({
      isOpen: true,
      message: '确定要删除这条记录吗？此操作不可恢复。',
      onConfirm: async () => {
        try {
          setHistory(await updateHistory((current) => current.filter((_, index) => index !== indexToDelete)));
        } catch (error) {
          console.error('删除单个历史记录失败', error);
        }
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
      }
    });
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4 sm:p-8 bg-black/40 backdrop-blur-sm">
      <div className={`glass-panel w-full flex flex-col gap-4 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 h-[85vh] ${isWindowMode ? 'max-w-5xl p-8 rounded-2xl' : 'max-w-[900px] p-6 rounded-xl'}`}>
        
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
        <div className="flex-1 overflow-hidden flex border-t border-white/5">
          {loading ? (
            <div className="w-full text-center text-slate-500 py-10">加载中...</div>
          ) : history.length === 0 ? (
            <div className="w-full text-center text-slate-500 py-10">暂无历史记录</div>
          ) : (
            <>
              {/* Sidebar */}
              <div className="w-56 flex-shrink-0 border-r border-white/5 overflow-y-auto custom-scrollbar bg-black/20">
                <div className="py-2">
                  {dates.map(dateStr => {
                    const isSelected = selectedDate === dateStr;
                    return (
                      <button
                        key={dateStr}
                        onClick={() => setSelectedDate(dateStr)}
                        className={`w-full text-left px-5 py-2.5 text-sm transition-all ${
                          isSelected 
                            ? 'bg-blue-500/10 text-blue-300 border-r-2 border-blue-500 font-medium' 
                            : 'text-slate-400 hover:bg-white/5 hover:text-slate-300'
                        }`}
                      >
                        {dateStr}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Main Content */}
              <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-black/10">
                {selectedDate && grouped[selectedDate] && (
                  <div className="space-y-4">
                    {grouped[selectedDate].map((entry) => {
                      const idx = entry.originalIndex;
                      const todosCount = entry.result.todos?.length || 0;
                      const isListExpanded = !!expandedTodos[`list_${idx}`];
                      const displayTodos = isListExpanded ? (entry.result.todos || []) : (entry.result.todos || []).slice(0, 3);

                      return (
                        <div 
                          key={idx} 
                          onDoubleClick={() => setConfirmingIdx(idx)}
                          className="bg-slate-900/50 p-4 rounded-lg border border-white/5 relative group cursor-pointer hover:border-blue-500/50 transition-colors"
                          title="双击恢复此记录"
                        >
                          {entry.result.feedbackStatus === 'processing' && (
                            <div className="absolute top-4 right-12 text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded border border-yellow-500/30 flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" /> 正在教导 AI...
                            </div>
                          )}
                          {entry.result.isRejected && (
                            <div className="absolute top-4 right-12 text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded border border-red-500/30">
                              ❌ 已发送纠错
                            </div>
                          )}
                          {entry.result.syncedToNotion && !entry.result.isRejected && (
                            <div className="absolute top-4 right-12 text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded border border-green-500/30">
                              已推送
                            </div>
                          )}
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteHistoryItem(idx);
                            }}
                            className="absolute top-4 right-4 p-1 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded opacity-0 group-hover:opacity-100 transition-all"
                            title="删除此记录"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <div className="text-xs text-slate-500 mb-2 pr-8">{new Date(entry.timestamp).toLocaleString()}</div>
                          
                          {entry.result.isRejected ? (
                            <div className="mt-3 bg-red-950/30 border border-red-500/20 p-3 rounded-md">
                              <div className="text-xs text-red-400 mb-1">您当时对 AI 的纠正/吐槽：</div>
                              <div className="text-sm text-slate-300 italic">"{entry.result.explicitFeedback || '暂无说明'}"</div>
                            </div>
                          ) : (
                            <>
                              <div className="text-sm text-slate-300 mb-3 line-clamp-2">{entry.result.summary}</div>
                              <div className="space-y-1.5">
                            {displayTodos.map((t: any, i) => {
                              const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled) || [];
                              const titleProp = activeFields.find(p => p.type === 'title')?.name || 'title';
                              const priorityProp = activeFields.find(p => p.name.includes('优先') || p.name === 'priority' || p.type === 'select')?.name || 'priority';
                              
                              const isUnselected = t.selected === false;
                              const isSynced = t.synced === true;
                              
                              return (
                                <div key={i} className={`text-xs flex items-center gap-2 ${isUnselected ? 'text-slate-600 line-through opacity-60' : 'text-slate-400'}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSynced ? 'bg-green-500/80' : isUnselected ? 'bg-slate-600/50' : 'bg-blue-500/50'}`} />
                                  {isSynced && <span className="text-green-500 shrink-0 border border-green-500/30 bg-green-500/10 px-1 rounded text-[10px]">已推</span>}
                                  {t[priorityProp] && <span className={isUnselected ? 'text-slate-600' : 'text-purple-400 shrink-0'}>[{t[priorityProp]}]</span>}
                                  <span className="truncate">{t[titleProp] || t.title || t.Name || '未命名待办'}</span>
                                </div>
                              )
                            })}
                            {todosCount === 0 && <div className="text-xs text-slate-500">无待办事项</div>}
                            
                            {todosCount > 3 && (
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleExpand(`list_${idx}`);
                                }}
                                className="w-full py-1.5 mt-2 text-xs text-slate-400 hover:text-slate-300 hover:bg-white/5 rounded border border-dashed border-white/10 transition-colors flex justify-center items-center gap-1"
                              >
                                {isListExpanded ? (
                                  <><ChevronUp className="w-3 h-3" /> 收起多余待办</>
                                ) : (
                                  <><ChevronDown className="w-3 h-3" /> 展开剩余 {todosCount - 3} 项待办...</>
                                )}
                              </button>
                            )}
                          </div>
                          </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
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

        {confirmDialog.isOpen && (
          <div className="absolute inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}>
            <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6 max-w-sm w-full shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{confirmDialog.message}</p>
              <div className="flex justify-end gap-3 pt-2">
                <button 
                  onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  取消
                </button>
                <button 
                  onClick={confirmDialog.onConfirm}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white shadow-lg transition active:scale-95 bg-red-600/90 hover:bg-red-500 shadow-red-500/20"
                >
                  确定删除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

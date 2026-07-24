import { useState, useEffect } from 'react'
import { X, Mail, RefreshCw, CheckCircle2, XCircle, ChevronDown, ChevronUp, ArrowLeft, Check, Loader2 } from 'lucide-react'
import { LazyStore } from '@tauri-apps/plugin-store'
import type { EmailHistoryItem } from './lib/emailScheduler'
import { forceRunEmailScanner } from './lib/emailScheduler'
import { useSettingsStore } from './store'
import { syncToNotion } from './lib/notion'

interface EmailTasksPanelProps {
  onClose: () => void;
}

const historyStore = new LazyStore('email_history.enc');

export default function EmailTasksPanel({ onClose }: EmailTasksPanelProps) {
  const { notionProperties, fieldMappings } = useSettingsStore();
  const [history, setHistory] = useState<EmailHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expandedTodos, setExpandedTodos] = useState<Record<string, boolean>>({});
  const [editingEntryIndex, setEditingEntryIndex] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  const updateTodo = async (todoId: string, field: string, value: any) => {
    if (editingEntryIndex === null) return;
    const newHistory = [...history];
    const entry = newHistory[editingEntryIndex];
    if (!entry.aiResult) return;
    
    entry.aiResult.todos = entry.aiResult.todos.map(t => 
      t.id === todoId ? { ...t, [field]: value } : t
    );
    setHistory(newHistory);
    await historyStore.set('history', newHistory);
    await historyStore.save();
  }

  const handleAddTodo = async () => {
    if (editingEntryIndex === null) return;
    const newHistory = [...history];
    const entry = newHistory[editingEntryIndex];
    if (!entry.aiResult) return;

    entry.aiResult.todos.push({
      id: Math.random().toString(36).substring(2, 11),
      selected: true,
      title: ''
    });
    setHistory(newHistory);
    await historyStore.set('history', newHistory);
    await historyStore.save();
  }

  const handleSyncNotion = async () => {
    if (editingEntryIndex === null) return;
    const entry = history[editingEntryIndex];
    if (!entry.aiResult || !entry.aiResult.todos) return;
    
    const selectedTodos = entry.aiResult.todos.filter(t => t.selected !== false);
    if (selectedTodos.length === 0) return;
    
    setSyncing(true);
    try {
      const syncRes = await syncToNotion(selectedTodos);
      const failed = syncRes.filter(r => !r.success);
      if (failed.length > 0) {
        throw new Error(`Failed to sync ${failed.length} items`);
      }
      
      const newHistory = [...history];
      newHistory[editingEntryIndex] = {
        ...newHistory[editingEntryIndex],
        syncedToNotion: true
      };
      setHistory(newHistory);
      await historyStore.set('history', newHistory);
      await historyStore.save();
    } catch (e: any) {
      console.error(e);
      alert('同步失败: ' + (e.message || String(e)));
    } finally {
      setSyncing(false);
    }
  }

  const toggleExpand = (key: string) => {
    setExpandedTodos(prev => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const data = await historyStore.get<EmailHistoryItem[]>('history') || [];
      setHistory(data);
    } catch (e) {
      console.error("加载邮箱历史记录失败", e);
    } finally {
      setLoading(false);
    }
  }

  const handleForceRun = async () => {
    setRunning(true);
    try {
      await forceRunEmailScanner();
      await loadHistory();
    } catch (e) {
      console.error(e);
    } finally {
      setRunning(false);
    }
  }

  if (editingEntryIndex !== null) {
    const entry = history[editingEntryIndex];
    const result = entry.aiResult;
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
        <div className="glass-panel w-full max-w-2xl p-6 flex flex-col gap-4 shadow-2xl relative animate-in slide-in-from-right-4 duration-200 h-[80vh]">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 pb-3 shrink-0">
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              <button 
                onClick={() => setEditingEntryIndex(null)}
                className="hover:bg-white/10 p-1.5 rounded transition-colors mr-1"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              处理待办 - {entry.subject || '(无主题)'}
            </h2>
            {entry.syncedToNotion && (
              <div className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded border border-green-500/30 font-medium">
                已推送
              </div>
            )}
          </div>
          
          <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
            {result ? (
              <div className="space-y-4">
                <div className="bg-slate-900/50 p-4 rounded-lg border border-white/5">
                  <h3 className="text-sm font-medium text-slate-200 mb-2">摘要总结</h3>
                  <p className="text-sm text-slate-400 leading-relaxed whitespace-pre-wrap">{result.summary}</p>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-slate-200">待办事项</h3>
                  {result.todos.map((todo) => (
                    <div key={todo.id} className="bg-slate-900/50 p-3 rounded-lg border border-white/5 flex gap-3 overflow-x-auto custom-scrollbar">
                      <div className="flex items-center justify-center h-7 shrink-0">
                        <input
                          type="checkbox"
                          checked={todo.selected !== false}
                          onChange={(e) => updateTodo(todo.id, 'selected', e.target.checked)}
                          disabled={entry.syncedToNotion}
                          className="w-4 h-4 rounded bg-slate-800 border-slate-600 focus:ring-offset-slate-900"
                        />
                      </div>
                      
                      {notionProperties?.filter(p => fieldMappings[p.id]?.enabled).sort((a, b) => (fieldMappings[a.id]?.order || 0) - (fieldMappings[b.id]?.order || 0)).map(field => {
                        if (field.type === 'select') {
                          return (
                            <select
                              key={field.id}
                              value={todo[field.name] || ''}
                              onChange={(e) => updateTodo(todo.id, field.name, e.target.value)}
                              disabled={entry.syncedToNotion}
                              className="text-xs font-mono text-purple-400 bg-purple-500/10 border-0 px-1.5 py-1 rounded cursor-pointer focus:ring-1 focus:ring-purple-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed max-w-[100px] truncate shrink-0"
                            >
                              <option value="">{field.name}</option>
                              {field.options?.map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          );
                        } else if (field.type === 'date') {
                          return (
                            <input
                              key={field.id}
                              type="date"
                              value={todo[field.name] || ''}
                              onChange={(e) => updateTodo(todo.id, field.name, e.target.value)}
                              disabled={entry.syncedToNotion}
                              className="text-xs text-slate-300 bg-white/5 border border-white/10 px-1.5 py-1 rounded cursor-pointer focus:ring-1 focus:ring-slate-400 outline-none disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                            />
                          );
                        } else if (field.type === 'checkbox') {
                          return (
                            <label key={field.id} className="flex items-center gap-1 text-xs text-slate-400 cursor-pointer shrink-0">
                              <input 
                                type="checkbox" 
                                checked={todo[field.name] === true} 
                                onChange={e => updateTodo(todo.id, field.name, e.target.checked)} 
                                disabled={entry.syncedToNotion} 
                                className="rounded bg-slate-800 border-slate-600 focus:ring-offset-slate-900" 
                              />
                              {field.name}
                            </label>
                          );
                        } else {
                          return (
                            <input 
                              key={field.id} 
                              type="text" 
                              value={todo[field.name] || ''} 
                              onChange={e => updateTodo(todo.id, field.name, e.target.value)} 
                              disabled={entry.syncedToNotion} 
                              placeholder={field.name} 
                              className="w-[120px] shrink-0 bg-transparent text-xs border-b border-white/10 focus:border-purple-500/50 outline-none text-slate-300 px-1" 
                            />
                          );
                        }
                      })}
                    </div>
                  ))}
                  
                  {!entry.syncedToNotion && (
                    <button 
                      onClick={handleAddTodo}
                      className="w-full py-2 flex items-center justify-center gap-1 text-xs text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-md border border-dashed border-white/10 transition-colors"
                    >
                      ➕ 手动添加待办
                    </button>
                  )}
                </div>

                {result.todos.length > 0 && (
                  <div className="flex justify-end mt-4">
                     <button 
                       onClick={handleSyncNotion}
                       disabled={syncing || result.todos.filter(t => t.selected !== false).length === 0 || entry.syncedToNotion}
                       className={`flex items-center gap-2 px-5 py-2 text-sm font-medium text-white rounded-md shadow-lg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${entry.syncedToNotion ? 'bg-green-600 shadow-green-500/20' : 'bg-orange-600 hover:bg-orange-500 shadow-orange-500/20'}`}
                     >
                       {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                       <span>{syncing ? '同步中...' : entry.syncedToNotion ? '已同步' : '同步至 Notion'}</span>
                     </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center text-slate-500 py-10">无大模型解析结果</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="glass-panel w-full max-w-2xl p-6 flex flex-col gap-4 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 h-[80vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-3 shrink-0">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Mail className="w-5 h-5 text-pink-400" />
            邮箱监听历史
          </h2>
          <div className="flex items-center gap-3">
            <button 
              onClick={handleForceRun} 
              disabled={running}
              className="text-xs flex items-center gap-1 bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} /> {running ? '执行中...' : '立即执行扫描'}
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
            <div className="text-center text-slate-500 py-10">暂无执行记录</div>
          ) : (
            history.map((entry, idx) => (
              <div 
                key={idx} 
                onDoubleClick={() => {
                  if (entry.status === 'success' && entry.aiResult) {
                    setEditingEntryIndex(idx);
                  }
                }}
                className={`bg-slate-900/50 p-4 rounded-lg border border-white/5 relative group transition-colors ${entry.status === 'success' ? 'cursor-pointer hover:border-purple-500/50' : ''}`}
                title={entry.status === 'success' ? '双击进入处理' : ''}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {entry.status === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-green-400" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-400" />
                    )}
                    <span className="text-xs text-slate-400">
                      执行时间: {new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {entry.syncedToNotion && (
                      <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded border border-green-500/30">
                        已推送
                      </span>
                    )}
                    <span className="text-xs text-slate-500 font-mono bg-black/30 px-1.5 rounded">
                      UID: {entry.emailUid}
                    </span>
                  </div>
                </div>
                
                <h3 className="text-sm font-medium text-slate-200 mb-1">{entry.subject || '(无主题)'}</h3>
                <div className="text-xs text-slate-400 mb-2 flex items-center gap-3">
                  <span className="truncate">发件人: {entry.sender}</span>
                  {entry.emailDate && <span className="shrink-0 text-slate-500">收件时间: {new Date(entry.emailDate).toLocaleString()}</span>}
                </div>

                {entry.status === 'failed' && (
                  <div className="mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 p-2 rounded">
                    {entry.error}
                  </div>
                )}

                {entry.status === 'success' && entry.aiResult && (
                  <div className="mt-2 bg-black/20 p-3 rounded border border-white/5">
                    <p className="text-sm text-slate-300 mb-2">{entry.aiResult.summary}</p>
                    {entry.aiResult.todos.length > 0 ? (
                      <div className="space-y-2 mt-3">
                        {entry.aiResult.todos.map((todo, tIdx) => {
                          const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled) || [];
                          const titleProp = activeFields.find(p => p.type === 'title')?.name || 'title';
                          const priorityProp = activeFields.find(p => p.name.includes('优先') || p.name === 'priority' || p.type === 'select')?.name || 'priority';
                          
                          const displayTitle = todo[titleProp] || todo.title || todo.Name || todo.name || '未命名待办';
                          const displayPriority = todo[priorityProp];
                          const expandKey = `${idx}-${tIdx}`;
                          const isExpanded = !!expandedTodos[expandKey];

                          return (
                            <div key={tIdx} className="bg-slate-900/40 rounded border border-white/5 overflow-hidden">
                              <div 
                                className="flex items-center justify-between p-2 cursor-pointer hover:bg-white/5 transition-colors"
                                onClick={() => toggleExpand(expandKey)}
                              >
                                <div className="flex items-center gap-2 text-xs flex-1 pr-2">
                                  <span className="w-1.5 h-1.5 rounded-full bg-pink-500 shrink-0" />
                                  {displayPriority && <span className="text-purple-400 shrink-0">[{displayPriority}]</span>}
                                  <span className="text-slate-200 font-medium line-clamp-1 break-all">{displayTitle}</span>
                                </div>
                                <button className="text-slate-500 hover:text-slate-300 p-1 shrink-0">
                                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                </button>
                              </div>
                              
                              {isExpanded && (
                                <div className="p-2 border-t border-white/5 bg-black/20 text-xs space-y-1.5">
                                  {Object.entries(todo).filter(([k]) => k !== 'id' && k !== 'selected').map(([k, v], i) => (
                                    <div key={i} className="grid grid-cols-[80px_1fr] gap-2 items-start">
                                      <span className="text-slate-500 text-right truncate" title={k}>{k}:</span>
                                      <span className="text-slate-300 break-words whitespace-pre-wrap">{String(v)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 mt-2">未提取到待办事项</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

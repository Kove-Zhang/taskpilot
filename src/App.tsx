import { useState, useRef, useEffect } from 'react'
import type { ClipboardEvent, ChangeEvent, DragEvent } from 'react'
import { Sparkles, Image as ImageIcon, FileText, Settings, Send, Loader2, X, Check, Clock, Wand2, PlusSquare, Mail, Minus, Maximize2 } from 'lucide-react'
import SettingsPanel from './SettingsPanel'
import HistoryPanel from './HistoryPanel'
import EmailTasksPanel from './EmailTasksPanel'
import { startEmailScheduler, stopEmailScheduler } from './lib/emailScheduler'
import { extractTodosFromContent, generateWriting } from './lib/ai'
import type { AIResult } from './lib/ai'
import { syncToNotion } from './lib/notion'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { parseFile } from './lib/parser'
import { logger } from './lib/logger'
import { useSettingsStore } from './store'
import { compressImage } from './lib/imageUtils'

export default function App() {
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showEmailHistory, setShowEmailHistory] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AIResult | null>(null)
  const [error, setError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  
  const { notionProperties, fieldMappings, isWindowMode } = useSettingsStore()
  const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled).sort((a, b) => {
    const orderA = fieldMappings[a.id]?.order ?? 999;
    const orderB = fieldMappings[b.id]?.order ?? 999;
    return orderA - orderB;
  }) || []
  const displayFields = activeFields.length > 0 ? activeFields : [
    { id: 't1', name: 'title', type: 'title' },
    { id: 't2', name: 'priority', type: 'select', options: ['★', '★★', '★★★'] },
    { id: 't3', name: 'planned_date', type: 'date' }
  ];

  const [writeIntent, setWriteIntent] = useState('')
  const [writingResult, setWritingResult] = useState('')
  const [writing, setWriting] = useState(false)
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isFileDialogOpen = useRef(false)
  const isScreenshotting = useRef(false)

  useEffect(() => {
    let unlisten: () => void;
    startEmailScheduler();
    
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused && !isDragging && !isWindowMode && !isFileDialogOpen.current && !isScreenshotting.current) {
        getCurrentWindow().hide();
      }
    }).then(fn => unlisten = fn);

    const setup = async () => {
      const globalShortcut = useSettingsStore.getState().globalShortcut;
      invoke('update_shortcut', { shortcut: globalShortcut }).catch(e => {
          logger.error('Failed to sync initial global shortcut', e);
      });
    };
    setup();
    return () => {
      if (unlisten) unlisten();
      stopEmailScheduler();
    }
  }, [isDragging, isWindowMode]);

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    let pastedImages = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          pastedImages++;
          compressImage(file).then(base64 => {
            setImages(prev => [...prev, base64]);
          }).catch(err => {
            logger.error('Image compression failed', err);
          });
        }
      }
    }
    if (pastedImages > 0) {
      logger.info(`Pasted ${pastedImages} images`);
    }
  }

  const handleFiles = async (files: FileList | File[]) => {
    setLoading(true);
    setError('');
    let appendedText = "";
    try {
      logger.info(`Processing ${files.length} dropped/selected files`);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith('image/')) {
          try {
            const base64 = await compressImage(file);
            setImages(prev => [...prev, base64]);
          } catch (err) {
            logger.error('File image compression failed', err);
          }
        } else {
          const text = await parseFile(file);
          appendedText += `\n[文件 ${file.name}]:\n${text}\n`;
        }
      }
      if (appendedText) {
        setInput(prev => prev + appendedText);
      }
    } catch (err: any) {
      setError(`解析文件出错: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  }

  const triggerScreenshot = async () => {
    try {
      logger.info('Triggering screenshot selection');
      const win = getCurrentWindow();
      isScreenshotting.current = true;
      await win.hide();
      await invoke("trigger_screenshot");
      setTimeout(() => {
        win.show();
        isScreenshotting.current = false;
      }, 3000);
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setError(msg);
      logger.error('Screenshot trigger failed', msg);
      isScreenshotting.current = false;
    }
  }

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  const handleExtract = async () => {
    if (!input && images.length === 0) return;
    setLoading(true);
    setError('');

    logger.info('Starting AI extraction...', { inputLength: input.length, imagesCount: images.length });
    try {
      const res = await extractTodosFromContent(input, images);
      res.id = Math.random().toString(36).substring(2, 11);
      setResult(res);
      logger.info('AI extraction success', { todosCount: res.todos.length });
      try {
        const historyJson = await invoke<string>("load_history");
        let historyArr = JSON.parse(historyJson || "[]");
        historyArr.unshift({ 
          timestamp: new Date().toISOString(), 
          result: res,
          input: input,
          images: images
        });
        if (historyArr.length > 50) {
          historyArr = historyArr.slice(0, 50);
        }
        await invoke("save_history", { data: JSON.stringify(historyArr) });
      } catch(e) {
        logger.warn("Failed to save history", e);
      }
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setError(msg);
      logger.error('AI extraction error', msg);
    } finally {
      setLoading(false);
    }
  }

  const handleSyncNotion = async () => {
    if (!result || result.todos.length === 0) return;
    const selectedTodos = result.todos.filter(t => t.selected !== false && !t.synced);
    if (selectedTodos.length === 0) {
      console.warn("当前没有可同步的待办事项：您选中的条目可能已全部同步至 Notion，或未勾选任何有效事项。");
      return;
    }
    
    setSyncing(true);
    setError('');
    logger.info('Syncing to Notion...', { count: selectedTodos.length });
    try {
      const syncResults = await syncToNotion(selectedTodos);
      
      const failed = syncResults.filter(r => !r.success);
      const succeeded = syncResults.filter(r => r.success);

      if (failed.length > 0) {
        const errorMsgs = failed.map(f => `条目错误: ${f.error}`).join('\n');
        setError(`部分同步失败 (${failed.length}/${selectedTodos.length}):\n${errorMsgs}`);
        logger.warn('Partial Notion sync failure', { failedCount: failed.length, errors: failed.map(f => f.error) });
      }

      setResult(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          syncedToNotion: failed.length === 0,
          todos: prev.todos.map(t => {
            if (succeeded.find(s => s.id === t.id)) {
              return { ...t, synced: true };
            }
            return t;
          })
        };
      });

      // 触发后台静默分析 (fire-and-forget)
      if (result.originalTodos) {
        import('./lib/autoOptimize').then(m => {
          m.backgroundReviewAndUpdateFocus(result.originalTodos!, selectedTodos).catch(console.error);
        });
      }
      
      const dataJson = await invoke<string>("load_history").catch(() => "[]");
      let history = JSON.parse(dataJson || "[]");
      history = history.map((h: any) => h.result?.id === result.id ? { 
        ...h, 
        result: { 
          ...h.result, 
          syncedToNotion: failed.length === 0,
          todos: h.result.todos.map((t: any) => {
            if (succeeded.find(s => s.id === t.id)) {
              return { ...t, synced: true };
            }
            return t;
          })
        } 
      } : h);
      await invoke("save_history", { data: JSON.stringify(history) }).catch(() => {});
      if (failed.length === 0) {
        logger.info('Sync to Notion complete (all success)');
      }

    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setError(msg);
      logger.error('Notion sync error', msg);
    } finally {
      setSyncing(false);
    }
  }

  const updateTodo = (id: string, field: string, value: any) => {
    setResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        todos: prev.todos.map(t => t.id === id ? { ...t, [field]: value } : t)
      }
    })
  }

  const handleAddTodo = () => {
    setResult(prev => {
      if (!prev) return prev;
      const today = new Date().toISOString().split('T')[0];
      const newTodo: any = {
        id: Math.random().toString(36).substr(2, 9),
        selected: true
      };
      displayFields.forEach(f => {
        if (f.type === 'date') newTodo[f.name] = today;
        else if (f.type === 'select' && f.options && f.options.length > 0) newTodo[f.name] = f.options[0];
        else if (f.type === 'checkbox') newTodo[f.name] = false;
        else newTodo[f.name] = '';
      });
      return {
        ...prev,
        todos: [...prev.todos, newTodo]
      }
    })
  }

  const startNewSession = () => {
    setInput('');
    setImages([]);
    setResult(null);
    setError('');

    setWriteIntent('');
    setWritingResult('');
  }

  const handleRestoreHistory = (restoredResult: any, restoredInput?: string, restoredImages?: string[]) => {
    setResult(restoredResult);

    setInput(restoredInput || '');
    setImages(restoredImages || []);
    setWriteIntent('');
    setWritingResult('');
  }

  const handleGenerateWriting = async () => {
    if (!result || result.todos.length === 0 || !writeIntent) return;
    setWriting(true);
    setError('');
    logger.info('Starting AI writing...', { intent: writeIntent });
    try {
      const generated = await generateWriting(writeIntent, result.todos, input, images);
      setWritingResult(generated);
      logger.info('AI writing success');
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setError(msg);
      logger.error('AI writing error', msg);
    } finally {
      setWriting(false);
    }
  }

  const handleCopyWriting = async () => {
    try {
      await navigator.clipboard.writeText(writingResult);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div 
      className="w-full h-full overflow-y-auto block relative"
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
      onDrop={handleDrop}
    >
      <div 
        className="min-h-[100vh] w-full overflow-y-auto custom-scrollbar flex flex-col items-center justify-center p-4 sm:p-8"
        onClick={async () => { if (!isWindowMode) await getCurrentWindow().hide() }}
      >
        {isWindowMode && (
          <>
            <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-10 cursor-move z-40" />
            <div className="fixed top-3 right-3 flex items-center z-50 overflow-hidden rounded-md backdrop-blur-md bg-white/5 border border-white/10 shadow-lg">
              <button onClick={() => getCurrentWindow().minimize()} className="p-2 text-slate-400 hover:text-white hover:bg-white/10 transition-colors" title="最小化">
                <Minus className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-white/10"></div>
              <button onClick={() => getCurrentWindow().toggleMaximize()} className="p-2 text-slate-400 hover:text-white hover:bg-white/10 transition-colors" title="全屏">
                <Maximize2 className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-white/10"></div>
              <button onClick={() => getCurrentWindow().hide()} className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/20 transition-colors" title="隐藏">
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
        <div 
          className={`glass-panel w-full mx-auto flex flex-col shadow-2xl transition-all duration-300 ${isWindowMode ? 'max-w-5xl p-8 gap-6 rounded-2xl' : 'max-w-3xl p-6 gap-4 rounded-xl'} ${isDragging ? 'border-purple-500 bg-purple-500/10' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="contents">
        
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-400" />
            <h1 className="text-lg font-semibold text-white tracking-wide">Task Pilot</h1>
          </div>
          <div className="flex items-center gap-2 relative z-10">
            <button 
              onClick={startNewSession}
              className="p-2 hover:bg-white/10 rounded-full transition-colors group"
              title="新会话"
            >
              <PlusSquare className="w-5 h-5 text-slate-400 group-hover:text-green-400" />
            </button>
            <button 
              onClick={() => setShowHistory(true)}
              className="p-2 hover:bg-white/10 rounded-full transition-colors group"
              title="历史记录"
            >
              <Clock className="w-5 h-5 text-slate-400 group-hover:text-blue-400" />
            </button>
            <button 
              onClick={() => setShowEmailHistory(true)}
              className="p-2 hover:bg-white/10 rounded-full transition-colors group"
              title="邮件监听历史"
            >
              <Mail className="w-5 h-5 text-slate-400 group-hover:text-pink-400" />
            </button>
            <button 
              onClick={() => setShowSettings(true)}
              className="p-2 hover:bg-white/10 rounded-full transition-colors group"
              title="设置"
            >
              <Settings className="w-5 h-5 text-slate-400 group-hover:text-white" />
            </button>
          </div>
        </div>

        <div className="relative">
          <textarea 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            placeholder={isDragging ? "松开鼠标以解析文件..." : "粘贴文字/图片，或拖拽文件 (Word/PDF/Excel) 到这里..."}
            className={`w-full bg-slate-900/50 border border-white/10 rounded-lg p-4 text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-none ${isWindowMode ? 'min-h-[240px]' : 'min-h-[120px]'} ${isDragging ? 'pointer-events-none' : ''}`}
          />
          {images.length > 0 && (
            <div className="absolute bottom-4 left-4 flex gap-2">
              {images.map((img, idx) => (
                <div key={idx} className="relative w-12 h-12 rounded bg-slate-800 border border-white/10 group cursor-pointer" onClick={() => setPreviewImage(img)} title="点击查看大图">
                  <img src={img} className="w-full h-full object-cover rounded hover:opacity-80 transition-opacity" />
                  <button onClick={() => removeImage(idx)} className="absolute -top-1 -right-1 bg-red-500 rounded-full w-4 h-4 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <div className="text-red-400 text-sm bg-red-500/10 p-2 rounded">{error}</div>}

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-3">
            <button 
              onClick={triggerScreenshot}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white/5 hover:bg-white/10 text-slate-300 rounded-md border border-white/5 transition-colors cursor-pointer"
            >
              <ImageIcon className="w-4 h-4" />
              <span>截屏选区</span>
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: 'none' }} 
              onChange={handleFileSelect} 
              multiple 
              accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,image/*" 
            />
            <button 
              onClick={() => {
                isFileDialogOpen.current = true;
                fileInputRef.current?.click();
                setTimeout(() => { isFileDialogOpen.current = false; }, 3000);
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white/5 hover:bg-white/10 text-slate-300 rounded-md border border-white/5 transition-colors cursor-pointer"
            >
              <FileText className="w-4 h-4" />
              <span>选择文件</span>
            </button>
          </div>

          <button 
            onClick={handleExtract}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-purple-600 hover:bg-purple-500 text-white rounded-md shadow-lg shadow-purple-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" 
            disabled={(!input && images.length === 0) || loading}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>{loading ? '提取中...' : '提取待办'}</span>
          </button>
        </div>

        {result && (
          <div className="mt-4 border-t border-white/10 pt-4 animate-in fade-in slide-in-from-bottom-2">
            <h3 className="text-sm font-medium text-purple-300 mb-2">摘要</h3>
            <div className="text-sm text-slate-300 bg-white/5 p-3 rounded-md border border-white/10 mb-4">
              {result.summary}
            </div>
            
            <h3 className="text-sm font-medium text-orange-300 mb-2 flex items-center gap-2">
              待办事项
              {result.syncedToNotion && (
                <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded border border-green-500/30">
                  已同步至 Notion，禁止修改
                </span>
              )}
            </h3>
            <div className="space-y-2 mb-4">
              {result.todos.map(todo => (
                <div key={todo.id} className={`flex items-center gap-2 bg-slate-900/50 p-2 rounded-md border border-white/5 group transition-colors ${todo.selected === false ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={todo.selected !== false}
                    onChange={(e) => updateTodo(todo.id, 'selected', e.target.checked)}
                    disabled={result.syncedToNotion}
                    className="w-4 h-4 rounded border-white/10 bg-slate-800 text-purple-500 focus:ring-purple-500/50 focus:ring-offset-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  />
                  
                  {displayFields.map(field => {
                    if (field.type === 'title' || field.type === 'rich_text') {
                      return (
                        <input 
                          key={field.id}
                          type="text" 
                          value={todo[field.name] || ''}
                          onChange={(e) => updateTodo(todo.id, field.name, e.target.value)}
                          disabled={result.syncedToNotion}
                          placeholder={field.name}
                          className={`flex-1 min-w-[80px] bg-transparent text-sm focus:outline-none focus:border-b focus:border-purple-500/50 px-1 ${todo.selected === false ? 'text-slate-500 line-through' : 'text-slate-200'} disabled:cursor-not-allowed`}
                        />
                      );
                    } else if (field.type === 'select') {
                      return (
                        <select
                          key={field.id}
                          value={todo[field.name] || ''}
                          onChange={(e) => updateTodo(todo.id, field.name, e.target.value)}
                          disabled={result.syncedToNotion}
                          className="text-xs font-mono text-purple-400 bg-purple-500/10 border-0 px-1.5 py-1 rounded cursor-pointer focus:ring-1 focus:ring-purple-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed max-w-[100px] truncate"
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
                          disabled={result.syncedToNotion}
                          className="text-xs text-slate-300 bg-white/5 border border-white/10 px-1.5 py-1 rounded cursor-pointer focus:ring-1 focus:ring-slate-400 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                      );
                    } else if (field.type === 'checkbox') {
                      return (
                        <label key={field.id} className="flex items-center gap-1 text-xs text-slate-400 cursor-pointer shrink-0">
                          <input 
                            type="checkbox" 
                            checked={todo[field.name] === true} 
                            onChange={e => updateTodo(todo.id, field.name, e.target.checked)} 
                            disabled={result.syncedToNotion} 
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
                          disabled={result.syncedToNotion} 
                          placeholder={field.name} 
                          className="w-16 bg-transparent text-xs border-b border-white/10 focus:border-purple-500/50 outline-none text-slate-300 px-1" 
                        />
                      );
                    }
                  })}
                </div>
              ))}
              {!result.syncedToNotion && (
                <button 
                  onClick={handleAddTodo}
                  className="w-full py-2 flex items-center justify-center gap-1 text-xs text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-md border border-dashed border-white/10 transition-colors"
                >
                  ➕ 手动添加待办
                </button>
              )}
            </div>
            
            {result.todos.length > 0 && (
              <div className="flex justify-end">
                 <button 
                   onClick={handleSyncNotion}
                   disabled={syncing || result.todos.filter(t => t.selected !== false).length === 0 || result.syncedToNotion}
                   className={`flex items-center gap-2 px-5 py-2 text-sm font-medium text-white rounded-md shadow-lg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${result.syncedToNotion ? 'bg-green-600 shadow-green-500/20' : 'bg-orange-600 hover:bg-orange-500 shadow-orange-500/20'}`}
                 >
                   {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                   <span>{syncing ? '同步中...' : result.syncedToNotion ? '已同步' : '同步至 Notion'}</span>
                 </button>
              </div>
            )}

            {result.todos.length > 0 && (
              <div className="mt-6 border-t border-white/10 pt-4">
                <h3 className="text-sm font-medium text-blue-300 mb-3 flex items-center gap-2">
                  <Wand2 className="w-4 h-4" /> AI 辅助撰写
                </h3>
                <div className="flex gap-2 mb-4">
                  <input
                    type="text"
                    value={writeIntent}
                    onChange={(e) => setWriteIntent(e.target.value)}
                    placeholder="输入撰写意图，例如：基于这些待办写一封周报"
                    className="flex-1 bg-slate-900/50 border border-white/10 rounded-md p-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleGenerateWriting}
                    disabled={writing || !writeIntent}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md shadow-lg shadow-blue-500/20 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {writing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    <span>生成</span>
                  </button>
                </div>

                {writingResult && (
                  <div className="animate-in fade-in slide-in-from-top-2">
                    <div className="bg-slate-900/80 border border-white/10 rounded-md p-3 max-h-60 overflow-y-auto text-sm text-slate-300 whitespace-pre-wrap custom-scrollbar mb-2">
                      {writingResult}
                    </div>
                    <div className="flex justify-end">
                      <button
                        onClick={handleCopyWriting}
                        className="text-xs text-blue-400 hover:text-blue-300 transition px-2 py-1 bg-blue-500/10 hover:bg-blue-500/20 rounded"
                      >
                        复制内容
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
          </div>
        </div>
      </div>

      {previewImage && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setPreviewImage(null)}
        >
          <img 
            src={previewImage} 
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl cursor-zoom-out" 
            alt="Preview"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewImage(null);
            }}
          />
        </div>
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showHistory && <HistoryPanel onClose={() => setShowHistory(false)} onRestore={handleRestoreHistory} />}
      {showEmailHistory && <EmailTasksPanel onClose={() => setShowEmailHistory(false)} />}
    </div>
  )
}

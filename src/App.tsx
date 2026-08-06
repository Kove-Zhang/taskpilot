import { lazy, Suspense, useState, useRef, useEffect} from 'react'
import type { ClipboardEvent, ChangeEvent, DragEvent} from 'react'
import { Sparkles, Image as ImageIcon, FileText, Settings, Send, Loader2, X, Check, Clock, Wand2, PlusSquare, Mail, Minus, Maximize2, AlertTriangle} from 'lucide-react'
import { startEmailScheduler, stopEmailScheduler} from './lib/emailScheduler'
import { extractTodosFromContent, generateWriting} from './lib/ai'
import type { AIResult} from './lib/ai'
import { markNotionSyncVerified, syncToNotion} from './lib/notion'
import { createNotionSyncFailureState, createNotionSyncInProgressState, getNotionSyncButtonLabel, getNotionSyncStatusLabel, resolveNotionSyncTodos, summarizeNotionSyncResults} from './lib/notionSyncState'
import { canProvideExplicitFeedback, getFeedbackType, isMissedExtractionFeedback} from './lib/feedbackAvailability'
import { createPositiveFeedbackSnapshot, runPositiveFeedbackLearning, shouldStartPositiveFeedbackLearning, type PositiveFeedbackSnapshot} from './lib/feedbackLearning'
import { invoke} from '@tauri-apps/api/core'
import { getCurrentWindow} from '@tauri-apps/api/window'
import { getCurrentWebview} from '@tauri-apps/api/webview'
import { assertFileBatchWithinLimits} from './lib/fileLimits'
import { logger} from './lib/logger'
import { useSettingsStore} from './store'
import { compressImage} from './lib/imageUtils'
import { updateHistory} from './lib/history'
import { AutoResizeTextarea} from './components/AutoResizeTextarea'
import { nativeDroppedFilePayloadsToFiles, type NativeFileDropEvent} from './lib/nativeFileDrop'

const SettingsPanel = lazy(() => import('./SettingsPanel'))
const HistoryPanel = lazy(() => import('./HistoryPanel'))
const EmailTasksPanel = lazy(() => import('./EmailTasksPanel'))

function PanelLoading() {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 text-sm text-slate-200">正在加载面板...</div>
}

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
  const [toast, setToast] = useState<{title: string, message: string} | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [notionRecovery, setNotionRecovery] = useState<{ todoIds: string[]; message: string; isOpen: boolean} | null>(null)
  const { notionProperties, fieldMappings, isWindowMode, globalShortcut} = useSettingsStore()
  const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled).sort((a, b) => {
    const orderA = fieldMappings[a.id]?.order ?? 999;
    const orderB = fieldMappings[b.id]?.order ?? 999;
    return orderA - orderB;
}) || []
  const displayFields = activeFields.length > 0 ? activeFields : [
    { id: 't1', name: 'title', type: 'title'},
    { id: 't2', name: 'priority', type: 'select', options: ['★', '★★', '★★★']},
    { id: 't3', name: 'planned_date', type: 'date'}
  ];

  const [writeIntent, setWriteIntent] = useState('')
  const [writingResult, setWritingResult] = useState('')
  const [writing, setWriting] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const isFileDialogOpen = useRef(false)
  const isScreenshotting = useRef(false)
  const domDragDepthRef = useRef(0)
  const suppressDomDropUntilRef = useRef(0)
  const handleFilesRef = useRef<(files: FileList | File[]) => Promise<void>>(async () => {})

  const isDraggingRef = useRef(isDragging);
  useEffect(() => { isDraggingRef.current = isDragging;}, [isDragging]);

  const isWindowModeRef = useRef(isWindowMode);
  useEffect(() => { isWindowModeRef.current = isWindowMode;}, [isWindowMode]);

  useEffect(() => {
    let unlisten: () => void;

    getCurrentWindow().onFocusChanged(({ payload: focused}) => {
      if (!focused && !isDraggingRef.current && !isWindowModeRef.current && !isFileDialogOpen.current && !isScreenshotting.current) {
        getCurrentWindow().hide();
    }
  }).then(fn => unlisten = fn);

    return () => {
      if (unlisten) unlisten();
  }
}, []);

  useEffect(() => {
    const showEvolutionToast = (e: Event) => {
      const customEvent = e as CustomEvent;
      setToast({
        title: customEvent.detail.title,
        message: customEvent.detail.message,
    });
      window.setTimeout(() => setToast(null), 5000);
  };
    window.addEventListener('ai-evolution-completed', showEvolutionToast);
    window.addEventListener('ai-evolution-failed', showEvolutionToast);
    return () => {
      window.removeEventListener('ai-evolution-completed', showEvolutionToast);
      window.removeEventListener('ai-evolution-failed', showEvolutionToast);
  };
}, []);

  useEffect(() => {
    startEmailScheduler();

    return () => {
      stopEmailScheduler();
  }
}, []);

  useEffect(() => {
    if (globalShortcut) {
      invoke('update_shortcut', { shortcut: globalShortcut}).catch(e => {
          logger.error('Failed to sync global shortcut', e);
    });
  }
}, [globalShortcut]);

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
    const selectedFiles = Array.from(files)
    try {
      assertFileBatchWithinLimits(selectedFiles)
  } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(`解析文件出错: ${message}`)
      return
  }

    setLoading(true)
    setError('')
    let appendedText = ''
    try {
      logger.info(`Processing ${selectedFiles.length} dropped/selected files`)
      const { parseFile} = await import('./lib/parser')
      for (const file of selectedFiles) {
        if (file.type.startsWith('image/')) {
          try {
            const base64 = await compressImage(file)
            setImages(prev => [...prev, base64])
        } catch (error) {
            logger.error('File image compression failed', error)
        }
      } else {
          const text = await parseFile(file)
          appendedText += `
[文件 ${file.name}]:
${text}
`
      }
    }
      if (appendedText) {
        setInput(prev => prev + appendedText)
    }
  } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(`解析文件出错: ${message}`)
  } finally {
      setLoading(false)
  }
}

  const handleExplicitFeedback = async () => {
    if (!result) return;
    const originalTodosToUse = result.originalTodos || result.todos || [];
    const currentId = result.id;
    const feedbackType = getFeedbackType(originalTodosToUse.length);
    if (!currentId) return;

    // 1. Immediately set the UI to 'processing'
    setResult({ ...result, feedbackStatus: 'processing', explicitFeedback: feedbackText, feedbackType});

    // 2. Persist to history immediately (so it's not lost on reload)
    try {
      await updateHistory((history) => history.map((entry) => entry.result?.id === currentId
        ? { ...entry, result: { ...entry.result, feedbackStatus: 'processing', explicitFeedback: feedbackText, feedbackType}}
        : entry));
  } catch (error) {
      console.error('Failed to update processing status in history', error);
  }

    // 3. Call AI
    try {
      const m = await import('./lib/autoOptimize');
      await m.backgroundReviewAndUpdateFocus(originalTodosToUse, [], feedbackText, feedbackType);

      // 4. Update history to 'completed' & 'isRejected'
      try {
        await updateHistory((history) => history.map((entry) => entry.result?.id === currentId
          ? { ...entry, result: { ...entry.result, feedbackStatus: 'completed', feedbackType, isRejected: feedbackType === 'over_extraction'}}
          : entry));
    } catch (error) {
        console.error('Failed to update completed status in history', error);
    }

      // 5. Update local UI to show success briefly, then close
      setResult(prev => prev && prev.id === currentId ? { ...prev, feedbackStatus: 'completed', feedbackType, isRejected: feedbackType === 'over_extraction'} : prev);
      setTimeout(() => {
        setResult(prev => prev && prev.id === currentId ? null : prev);
        setShowFeedback(false);
        setFeedbackText('');
    }, 1500);

  } catch (e) {
      console.error(e);
      // Revert if it failed
      setResult(prev => prev && prev.id === currentId ? { ...prev, feedbackStatus: undefined} : prev);
  }
};

  handleFilesRef.current = handleFiles

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    getCurrentWebview().listen<NativeFileDropEvent>('native-file-drag-drop', (event) => {
      const payload = event.payload
      if (payload.type === 'enter' || payload.type === 'over') {
        setIsDragging(true)
        return
    }
      if (payload.type === 'leave') {
        setIsDragging(false)
        return
    }

      suppressDomDropUntilRef.current = Date.now() + 1000
      domDragDepthRef.current = 0
      setIsDragging(false)
      const files = nativeDroppedFilePayloadsToFiles(payload.files || [])
      if (payload.errors && payload.errors.length > 0) {
        setError(payload.errors.join('\n'))
    }
      if (files.length > 0) {
        void handleFilesRef.current(files)
    }
  }).then((removeListener) => {
      if (disposed) {
        removeListener()
    } else {
        unlisten = removeListener
    }
  }).catch((error) => {
      // Browser development mode does not expose the Tauri event bridge; DOM fallback remains available.
      logger.warn('Native file drag/drop listener unavailable', error)
  })

    return () => {
      disposed = true
      unlisten?.()
  }
}, [])

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    domDragDepthRef.current += 1
    setIsDragging(true)
}

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragging(true)
}

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    domDragDepthRef.current = Math.max(0, domDragDepthRef.current - 1)
    if (domDragDepthRef.current === 0) setIsDragging(false)
}

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    domDragDepthRef.current = 0
    setIsDragging(false)
    if (Date.now() < suppressDomDropUntilRef.current) return
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files)
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
    setNotionRecovery(null);

    logger.info('Starting AI extraction...', { inputLength: input.length, imagesCount: images.length});
    try {
      const res = await extractTodosFromContent(input, images);
      res.id = Math.random().toString(36).substring(2, 11);
      setResult(res);
      logger.info('AI extraction success', { todosCount: res.todos.length});
      try {
        await updateHistory((history) => [{
          timestamp: new Date().toISOString(),
          result: res,
          input,
          images,
      }, ...history].slice(0, 50));
    } catch (error) {
        logger.warn('Failed to save history', error);
    }
  } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setError(msg);
      logger.error('AI extraction error', msg);
  } finally {
      setLoading(false);
  }
}

  const persistPositiveFeedbackState = async (
    resultId: string,
    status: AIResult['positiveFeedbackStatus'],
    fingerprint: string,
    error?: string,
  ) => {
    const updatedAt = Date.now();
    setResult(prev => prev && prev.id === resultId
      ? {
          ...prev,
          positiveFeedbackStatus: status,
          positiveFeedbackFingerprint: fingerprint,
          positiveFeedbackUpdatedAt: updatedAt,
          positiveFeedbackError: error,
      }
      : prev);
    try {
      await updateHistory((history) => history.map((entry) => entry.result?.id === resultId
        ? {
            ...entry,
            result: {
              ...entry.result,
              positiveFeedbackStatus: status,
              positiveFeedbackFingerprint: fingerprint,
              positiveFeedbackUpdatedAt: updatedAt,
              positiveFeedbackError: error,
          },
        }
        : entry));
  } catch (persistError) {
      logger.warn('Failed to persist positive feedback status', persistError);
  }
};

  const startPositiveFeedbackLearning = (resultId: string, snapshot: PositiveFeedbackSnapshot) => {
    void runPositiveFeedbackLearning(snapshot)
      .then((outcome) => persistPositiveFeedbackState(
        resultId,
        outcome === 'updated' ? 'completed' : outcome === 'unchanged' ? 'unchanged' : 'skipped',
        snapshot.fingerprint,
      ))
      .catch((error) => persistPositiveFeedbackState(
        resultId,
        'failed',
        snapshot.fingerprint,
        error instanceof Error ? error.message : String(error),
      ));
};

  const retryPositiveFeedbackLearning = async () => {
    if (!result?.id) return;
    const snapshot = createPositiveFeedbackSnapshot(result.originalTodos || result.todos, result.todos);
    if (!snapshot.changed) return;
    await persistPositiveFeedbackState(result.id, 'processing', snapshot.fingerprint);
    startPositiveFeedbackLearning(result.id, snapshot);
};

  const persistVerifiedNotionTodos = async (todoIds: string[]) => {
    if (!result) return;

    const todoIdSet = new Set(todoIds);
    for (const todo of result.todos) {
      if (todoIdSet.has(todo.id)) {
        await markNotionSyncVerified(todo);
    }
  }

    const todos = result.todos.map(todo => (
      todoIdSet.has(todo.id) ? { ...todo, synced: true} : todo
    ));
    const selectedTodos = todos.filter(todo => todo.selected !== false);
    const learningSnapshot = createPositiveFeedbackSnapshot(
      result.originalTodos || result.todos,
      todos,
    );
    const shouldLearn = shouldStartPositiveFeedbackLearning(result, learningSnapshot);
    const nextResult = {
      ...result,
      todos,
      syncedToNotion: selectedTodos.length > 0 && selectedTodos.every(todo => todo.synced),
      notionSync: resolveNotionSyncTodos(result.notionSync, todoIds),
      ...(shouldLearn
        ? {
            positiveFeedbackStatus: 'processing' as const,
            positiveFeedbackFingerprint: learningSnapshot.fingerprint,
            positiveFeedbackUpdatedAt: Date.now(),
            positiveFeedbackError: undefined,
        }
        : {}),
  };
    setResult(nextResult);
    await updateHistory((history) => history.map((entry) => entry.result?.id === result.id
      ? { ...entry, result: nextResult}
      : entry));
    if (shouldLearn) startPositiveFeedbackLearning(result.id || '', learningSnapshot);
}

  const handleSyncNotion = async (forceTodoIds?: string[]) => {
    if (!result || result.todos.length === 0) return;

    const pendingVerificationIds = notionRecovery?.todoIds || result.notionSync?.uncertainTodoIds || [];
    if (!forceTodoIds && pendingVerificationIds.length > 0) {
      const uncertainTitles = result.todos
        .filter(todo => pendingVerificationIds.includes(todo.id))
        .map(todo => `「${todo.title || todo.id}」`)
        .join('、');
      setNotionRecovery({
        todoIds: pendingVerificationIds,
        isOpen: true,
        message: `以下待办的 Notion 推送结果无法确认：${uncertainTitles || '部分待办'}。\n\n${result.notionSync?.lastError || ''}\n\n请先在 Notion 中核对：如果页面已存在，请标记为已同步；如果确认未创建，再强制重试。强制重试可能产生重复页面。`,
    });
      return;
  }

    const forceIdSet = forceTodoIds ? new Set(forceTodoIds) : null;
    const selectedTodos = result.todos.filter(todo => (
      todo.selected !== false &&
      !todo.synced &&
      (!forceIdSet || forceIdSet.has(todo.id))
    ));
    if (selectedTodos.length === 0) {
      setError("当前没有可同步的待办事项：您选中的条目可能已全部同步至 Notion，或未勾选任何有效事项。");
      return;
  }

    const positiveFeedbackSnapshot = createPositiveFeedbackSnapshot(
      result.originalTodos || result.todos,
      result.todos,
    );
    const shouldLearnAfterSync = shouldStartPositiveFeedbackLearning(result, positiveFeedbackSnapshot);

    setNotionRecovery(null);
    setSyncing(true);
    setError('');
    const syncingResult = {
      ...result,
      notionSync: createNotionSyncInProgressState(
        selectedTodos.length,
        selectedTodos.map(todo => todo.id),
      ),
  };
    setResult(syncingResult);
    logger.info('Syncing to Notion...', { count: selectedTodos.length, forced: !!forceTodoIds});
    try {
      const syncResults = await syncToNotion(
        selectedTodos,
        forceTodoIds ? { forceTodoIds} : undefined,
      );

      const failed = syncResults.filter(r => !r.success);
      const succeeded = syncResults.filter(r => r.success);
      const uncertainResults = failed.filter(item => item.needsVerification);
      const succeededIds = new Set(succeeded.map((item) => item.id));
      const todos = result.todos.map(todo => (
        succeededIds.has(todo.id) ? { ...todo, synced: true} : todo
      ));
      const selectedResultTodos = todos.filter(todo => todo.selected !== false);
      const shouldTrackLearning = shouldLearnAfterSync && succeeded.length > 0;
      const nextResult = {
        ...result,
        todos,
        syncedToNotion: selectedResultTodos.length > 0 && selectedResultTodos.every(todo => todo.synced),
        notionSync: summarizeNotionSyncResults(syncResults, selectedTodos.length),
        ...(shouldTrackLearning
          ? {
              positiveFeedbackStatus: uncertainResults.length > 0 ? 'pending_verification' as const : 'processing' as const,
              positiveFeedbackFingerprint: positiveFeedbackSnapshot.fingerprint,
              positiveFeedbackUpdatedAt: Date.now(),
              positiveFeedbackError: undefined,
          }
          : {}),
    };

      if (failed.length > 0) {
        const errorMsgs = failed.map(f => `条目错误: ${f.error}`).join('\n');
        setError(`部分同步失败 (${failed.length}/${selectedTodos.length}):\n${errorMsgs}`);
        logger.warn('Partial Notion sync failure', { failedCount: failed.length, errors: failed.map(f => f.error)});
    }

      setResult(nextResult);
      await updateHistory((history) => history.map((entry) => entry.result?.id === result.id
        ? { ...entry, result: nextResult}
        : entry));

      if (shouldTrackLearning && uncertainResults.length === 0) {
        startPositiveFeedbackLearning(result.id || '', positiveFeedbackSnapshot);
    }

      if (uncertainResults.length > 0) {
        const uncertainIds = uncertainResults.map(item => item.id);
        const uncertainTitles = selectedTodos
          .filter(todo => uncertainIds.includes(todo.id))
          .map(todo => `「${todo.title || todo.id}」`)
          .join('、');
        setNotionRecovery({
          todoIds: uncertainIds,
          isOpen: true,
          message: `以下待办的 Notion 推送结果无法确认：${uncertainTitles || '部分待办'}。\n\n${nextResult.notionSync?.lastError || ''}\n\n请先在 Notion 中核对：如果页面已存在，请标记为已同步；如果确认未创建，再强制重试。强制重试可能产生重复页面。`,
      });
    } else if (failed.length === 0) {
        logger.info('Sync to Notion complete (all success)');
    }
  } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      const failedState = createNotionSyncFailureState(
        selectedTodos.length,
        selectedTodos.map(todo => todo.id),
        msg,
      );
      const failedResult = {
        ...result,
        notionSync: failedState,
    };
      setResult(failedResult);
      await updateHistory((history) => history.map((entry) => entry.result?.id === result.id
        ? { ...entry, result: failedResult}
        : entry));
      setError(msg);
      logger.error('Notion sync error', msg);
  } finally {
      setSyncing(false);
  }
}

  const handleMarkNotionRecovery = async () => {
    if (!notionRecovery) return;
    const todoIds = notionRecovery.todoIds;
    setNotionRecovery(null);
    setSyncing(true);
    try {
      await persistVerifiedNotionTodos(todoIds);
      setError('');
      setToast({ title: '✅ 已标记为已同步', message: '已将核对确认存在的 Notion 页面标记为已同步。'});
      setTimeout(() => setToast(null), 3000);
  } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setError(`标记 Notion 同步状态失败：${msg}`);
      logger.error('Mark Notion sync verified error', msg);
  } finally {
      setSyncing(false);
  }
}

  const handleForceNotionRecovery = async () => {
    if (!notionRecovery) return;
    const todoIds = notionRecovery.todoIds;
    setNotionRecovery(null);
    await handleSyncNotion(todoIds);
}

  const updateTodo = (id: string, field: string, value: any) => {
    setResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        todos: prev.todos.map(t => t.id === id ? { ...t, [field]: value} : t)
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
    setNotionRecovery(null);

    setWriteIntent('');
    setWritingResult('');
}

  const handleRestoreHistory = (restoredResult: any, restoredInput?: string, restoredImages?: string[]) => {
    setResult(restoredResult);
    setNotionRecovery(null);

    setInput(restoredInput || '');
    setImages(restoredImages || []);
    setWriteIntent('');
    setWritingResult('');
}

  const handleGenerateWriting = async () => {
    if (!result || result.todos.length === 0 || !writeIntent) return;
    setWriting(true);
    setError('');
    logger.info('Starting AI writing...', { intent: writeIntent});
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
      setToast({ title: '✅ 复制成功', message: '内容已复制到剪贴板'});
      setTimeout(() => setToast(null), 3000);
  } catch (e) {
      console.error(e);
      setToast({ title: '❌ 复制失败', message: '无法写入剪贴板，请重试'});
      setTimeout(() => setToast(null), 3000);
  }
}

  const notionStatus = result?.notionSync?.status || (result?.syncedToNotion ? 'success' : 'idle');
  const notionStatusLabel = getNotionSyncStatusLabel(result?.notionSync);
  const notionButtonLabel = getNotionSyncButtonLabel(result?.notionSync, !!notionRecovery, !!result?.syncedToNotion);
  const selectedSyncTodoCount = result?.todos.filter(todo => todo.selected !== false && !todo.synced).length || 0;
  const hasPendingVerification = !!notionRecovery || notionStatus === 'needs_verification';
  const notionStatusClass = notionStatus === 'success'
    ? 'bg-green-500/15 text-green-300 border-green-500/30'
    : notionStatus === 'needs_verification'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : notionStatus === 'partial_failed'
        ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
        : notionStatus === 'failed'
          ? 'bg-red-500/15 text-red-300 border-red-500/30'
          : 'bg-slate-500/15 text-slate-300 border-slate-500/30';

  return (
    <div
      className="w-full h-full overflow-y-auto block relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className="min-h-[100vh] w-full overflow-y-auto custom-scrollbar flex flex-col items-center justify-center p-4 sm:p-8"
        onClick={async () => { if (!isWindowMode) await getCurrentWindow().hide()}}
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
              data-testid="open-settings"
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
            className={`w-full bg-slate-900/50 border border-white/10 rounded-lg p-4 text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-none ${isWindowMode ? 'min-h-[240px]' : 'min-h-[120px]'}`}
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
              style={{ display: 'none'}}
              onChange={handleFileSelect}
              multiple
              accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,image/*"
            />
            <button
              onClick={() => {
                isFileDialogOpen.current = true;
                fileInputRef.current?.click();
                setTimeout(() => { isFileDialogOpen.current = false;}, 3000);
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
                        <AutoResizeTextarea
                          key={field.id}
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
                        <AutoResizeTextarea
                          key={field.id}
                          value={todo[field.name] || ''}
                          onChange={e => updateTodo(todo.id, field.name, e.target.value)}
                          disabled={result.syncedToNotion}
                          placeholder={field.name}
                          className="flex-1 min-w-[120px] bg-transparent text-xs border-b border-white/10 focus:border-purple-500/50 outline-none text-slate-300 px-1"
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

            <div className="flex flex-col gap-3 mt-4">
              <div className="flex justify-end items-center gap-2">
                {canProvideExplicitFeedback(result.feedbackStatus) && (
                  <button
                    onClick={() => setShowFeedback(!showFeedback)}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-400 bg-transparent hover:bg-white/5 hover:text-slate-300 rounded-md transition-colors"
                  >
                    {result.todos.length === 0 ? '⚠️ 没有提取到待办？补充告诉 AI' : '👎 提取太差？教教 AI'}
                  </button>
                )}
                {result.todos.length > 0 && (
                  <>
                    {notionStatusLabel && (
                      <span
                        className={`hidden sm:inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${notionStatusClass}`}
                        title={result.notionSync?.lastError || undefined}
                      >
                        {notionStatusLabel}
                        {result.notionSync && result.notionSync.failedCount > 0 && ` · ${result.notionSync.failedCount} 项`}
                      </span>
                    )}
                    <button
                      onClick={() => void handleSyncNotion()}
                      disabled={syncing || (selectedSyncTodoCount === 0 && !hasPendingVerification) || result.syncedToNotion || result.feedbackStatus === 'processing' || result.feedbackStatus === 'completed'}
                      title={result.notionSync?.lastError || undefined}
                      className={`flex items-center gap-2 px-5 py-2 text-sm font-medium text-white rounded-md shadow-lg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${notionStatus === 'success' ? 'bg-green-600 shadow-green-500/20' : notionStatus === 'failed' ? 'bg-red-600 hover:bg-red-500 shadow-red-500/20' : notionStatus === 'partial_failed' || notionStatus === 'needs_verification' ? 'bg-amber-600 hover:bg-amber-500 shadow-amber-500/20' : 'bg-orange-600 hover:bg-orange-500 shadow-orange-500/20'}`}
                    >
                      {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : notionStatus === 'success' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                      <span>{notionButtonLabel}</span>
                    </button>
                  </>
                )}
              </div>

              {result.positiveFeedbackStatus === 'processing' && (
                <div className="animate-in fade-in bg-purple-900/20 border border-purple-500/30 p-3 rounded-lg flex items-center gap-2 text-xs text-purple-200">
                  <Loader2 className="w-4 h-4 animate-spin" /> 正在分析本次同步选择并优化全局规则...
                </div>
              )}
              {result.positiveFeedbackStatus === 'pending_verification' && (
                <div className="animate-in fade-in bg-amber-900/20 border border-amber-500/30 p-3 rounded-lg text-xs text-amber-200">
                  ⏸️ Notion 结果待核对，确认页面状态后再提交正反馈学习。
                </div>
              )}
              {result.positiveFeedbackStatus === 'unchanged' && (
                <div className="animate-in fade-in bg-green-900/20 border border-green-500/30 p-3 rounded-lg text-xs text-green-200">
                  ✅ 正反馈已记录，当前规则无需额外修改。
                </div>
              )}
              {result.positiveFeedbackStatus === 'failed' && (
                <div className="animate-in fade-in bg-red-900/20 border border-red-500/30 p-3 rounded-lg flex items-center justify-between gap-3 text-xs text-red-200">
                  <span>⚠️ 正反馈学习失败：{result.positiveFeedbackError || '未知错误'}</span>
                  <button onClick={retryPositiveFeedbackLearning} className="px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30">重试</button>
                </div>
              )}

              {showFeedback && canProvideExplicitFeedback(result.feedbackStatus) && (
                <div className="animate-in fade-in slide-in-from-top-2 bg-slate-900/80 border border-red-500/30 p-4 rounded-lg flex flex-col gap-3">
                  <p className="text-xs text-slate-400">
                    {result.todos.length === 0
                      ? <>本次<strong className="text-amber-300">没有提取出待办</strong>。请补充哪些行动项被遗漏、常见表达或截止时间线索，系统会将其作为<strong className="text-amber-300">漏提取样本</strong>交给 AI 学习。</>
                      : <>请简单说明原因，系统会将本次所有提取结果作为<span className="text-red-400">反面教材</span>发给 AI 深度学习，并清空当前结果。</>}
                  </p>
                  <textarea
                    value={feedbackText}
                    onChange={e => setFeedbackText(e.target.value)}
                    placeholder={result.todos.length === 0
                      ? '例如：邮件中“请周五前确认报价”应识别为待办；看到“请确认 / 跟进 / 提交 / 截止”要提取。'
                      : '（可选）吐槽一下，例如：不要提取没有明确动作的废话，不要包含节假日祝福'}
                    className="w-full bg-black/50 border border-white/10 rounded-md p-2 text-sm text-slate-300 focus:outline-none focus:border-red-500/50 min-h-[60px]"
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={handleExplicitFeedback}
                      className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors"
                    >
                      {result.todos.length === 0 ? '发送漏提取反馈' : '发送纠正并废弃本次结果'}
                    </button>
                  </div>
                </div>
              )}

              {result.feedbackStatus === 'processing' && (
                <div className="animate-in fade-in bg-slate-800/80 border border-yellow-500/30 p-4 rounded-lg flex items-center justify-center gap-3">
                  <Loader2 className="w-5 h-5 text-yellow-500 animate-spin" />
                  <span className="text-sm text-yellow-100">⏳ 正在让大模型深度反思中 (后台干活中，您可以继续处理其他事务)</span>
                </div>
              )}

              {result.feedbackStatus === 'completed' && (
                <div className="animate-in fade-in zoom-in bg-green-900/30 border border-green-500/30 p-4 rounded-lg flex items-center justify-center gap-3">
                  <Check className="w-5 h-5 text-green-400" />
                  <span className="text-sm text-green-100">{isMissedExtractionFeedback(result.feedbackType) ? '✅ 已记录漏提取反馈，AI 会学习识别类似行动线索。' : '✅ 感谢调教！AI 已深刻吸取教训，相关规则已更新。'}</span>
                </div>
              )}
            </div>

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

      {showSettings && <Suspense fallback={<PanelLoading />}><SettingsPanel onClose={() => setShowSettings(false)} /></Suspense>}
      {showHistory && <Suspense fallback={<PanelLoading />}><HistoryPanel onClose={() => setShowHistory(false)} onRestore={handleRestoreHistory} /></Suspense>}
      {showEmailHistory && <Suspense fallback={<PanelLoading />}><EmailTasksPanel onClose={() => setShowEmailHistory(false)} /></Suspense>}

      {notionRecovery?.isOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={(event) => {
            event.stopPropagation();
            setNotionRecovery(prev => prev ? { ...prev, isOpen: false} : prev);
        }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="notion-recovery-title"
            className="w-full max-w-lg rounded-xl border border-amber-500/30 bg-slate-900 p-6 shadow-2xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
              <div>
                <h3 id="notion-recovery-title" className="text-lg font-semibold text-white">Notion 推送结果需要核对</h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{notionRecovery.message}</p>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-3">
              <button
                onClick={() => setNotionRecovery(prev => prev ? { ...prev, isOpen: false} : prev)}
                className="rounded-md bg-white/5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
              >
                取消
              </button>
              <button
                onClick={() => void handleMarkNotionRecovery()}
                disabled={syncing}
                className="rounded-md border border-amber-500/30 bg-amber-500/15 px-4 py-2 text-sm text-amber-200 transition-colors hover:bg-amber-500/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                已存在，标记已同步
              </button>
              <button
                onClick={() => void handleForceNotionRecovery()}
                disabled={syncing}
                className="rounded-md bg-orange-600 px-4 py-2 text-sm text-white shadow-lg shadow-orange-500/20 transition-colors hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                确认未创建，强制重试
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[100] animate-in slide-in-from-bottom-8 slide-in-from-right-8 fade-in duration-500">
          <div className="relative flex items-start gap-3 bg-slate-900/85 backdrop-blur-md border border-purple-500/40 p-4 pr-8 rounded-xl shadow-2xl shadow-purple-900/30 max-w-sm">
            <div className="bg-purple-500/20 p-2 rounded-lg shrink-0 mt-0.5">
              <Sparkles className="w-5 h-5 text-purple-400 animate-pulse" />
            </div>
            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-semibold text-purple-300 tracking-wide">{toast.title}</h4>
              <p className="text-xs text-slate-400 leading-relaxed">{toast.message}</p>
            </div>
            <button
              onClick={() => setToast(null)}
              className="absolute top-2 right-2 text-slate-500 hover:text-slate-300 bg-transparent hover:bg-white/10 p-1 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}




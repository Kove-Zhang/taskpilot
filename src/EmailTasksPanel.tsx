import { useState, useEffect, useMemo, useCallback } from 'react'
import { X, Mail, RefreshCw, CheckCircle2, XCircle, ChevronDown, ChevronUp, ArrowLeft, Check, Loader2, Trash2, Play, Pause, Square, Rocket, ScrollText, ArrowRight, Clock, UploadCloud, Terminal, AlertTriangle } from 'lucide-react'
import { LazyStore } from '@tauri-apps/plugin-store'
import type { EmailHistoryItem } from './lib/emailScheduler'
import { cancelActiveEmailScan, forceRunEmailScanner } from './lib/emailScheduler'
import { useSettingsStore, useScannerStore } from './store'
import { markNotionSyncVerified, syncToNotion } from './lib/notion'
import { createNotionSyncFailureState, createNotionSyncInProgressState, getNotionSyncButtonLabel, getNotionSyncStatusLabel, resolveNotionSyncTodos, summarizeNotionSyncResults } from './lib/notionSyncState'
import { decodeIMAPFolder } from './lib/imapFolder'
import { parseEmailThread } from './lib/emailThreadParser'
import { sanitizeEmailHtml } from './lib/emailHtml'
import { canProvideExplicitFeedback, getFeedbackType, isMissedExtractionFeedback } from './lib/feedbackAvailability'
import { AutoResizeTextarea } from './components/AutoResizeTextarea'
import { FeedbackHistoryCard, FeedbackStatusBadge } from './components/FeedbackHistoryCard'
import { createPositiveFeedbackSnapshot, runPositiveFeedbackLearning, shouldStartPositiveFeedbackLearning, type PositiveFeedbackSnapshot } from './lib/feedbackLearning'

interface EmailTasksPanelProps {
  onClose: () => void;
}

const historyStore = new LazyStore('email_history.enc');



export default function EmailTasksPanel({ onClose }: EmailTasksPanelProps) {
  const { notionProperties, fieldMappings, isWindowMode } = useSettingsStore();
  const [history, setHistory] = useState<EmailHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { running, paused, status, stopRequested, progressMsg, scanLogs, historyVersion, setPaused, requestStop } = useScannerStore();
  const isStopping = status === 'stopping' || stopRequested;
  const scanStatusText = status === 'stopping'
    ? '正在停止，等待当前邮件处理完成...'
    : status === 'paused'
      ? '扫描已暂停，等待继续...'
      : progressMsg || (running ? '正在同步拉取与解析邮件...' : status === 'stopped' ? '扫描已停止' : '当前无正在执行的扫描任务');
  const [hideStatusBar, setHideStatusBar] = useState(false);

  useEffect(() => {
    if (running) setHideStatusBar(false);
  }, [running]);
  const [showMiniLog, setShowMiniLog] = useState(false);
  const [inReviewMode, setInReviewMode] = useState(false);
  const [reviewFilterUnreviewed, setReviewFilterUnreviewed] = useState(true);
  const [reviewFilterReviewed, setReviewFilterReviewed] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [expandedTodos, setExpandedTodos] = useState<Record<string, boolean>>({});
  const [editingEntryIndex, setEditingEntryIndex] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [feedbackEntryIdx, setFeedbackEntryIdx] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [activeTab, setActiveTab] = useState<'todos' | 'original'>('todos');
  const [previewDrawerOpen, setPreviewDrawerOpen] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [selectionSource, setSelectionSource] = useState<string>('');
  const [expandedThreads, setExpandedThreads] = useState<Record<number, boolean>>({});
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [emailViewMode, setEmailViewMode] = useState<'light' | 'dark'>('light');
  const [notionVerificationByEntry, setNotionVerificationByEntry] = useState<Record<string, { todoIds: string[]; message: string }>>({});
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    message: string;
    isAlert?: boolean;
    confirmLabel?: string;
    secondaryLabel?: string;
    onSecondary?: () => void | Promise<void>;
    onConfirm: () => void | Promise<void>;
  }>({ isOpen: false, message: '', onConfirm: () => {} });

  const showAlert = (message: string) => {
    setConfirmDialog({
      isOpen: true,
      message,
      isAlert: true,
      onConfirm: () => setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    });
  };

  const [selectedGroup, setSelectedGroup] = useState<{ folder: string, date: string } | null>(null);
  const getNotionRecoveryKey = (entry: EmailHistoryItem, fallbackIndex: number) => `${entry.emailUidValidity ?? 'unknown'}:${entry.emailUid}:${entry.timestamp || fallbackIndex}`;

  const openNotionRecoveryDialog = (targetIdx: number, recoveryKey: string, recovery: { todoIds: string[]; message: string }) => {
    setNotionVerificationByEntry(prev => ({ ...prev, [recoveryKey]: recovery }));
    setConfirmDialog({
      isOpen: true,
      isAlert: false,
      message: recovery.message,
      secondaryLabel: '已存在，标记已同步',
      confirmLabel: '确认未创建，强制重试',
      onSecondary: async () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
        try {
          await persistVerifiedNotionTodos(targetIdx, recovery.todoIds);
          setNotionVerificationByEntry(prev => {
            const next = { ...prev };
            delete next[recoveryKey];
            return next;
          });
        } catch (error) {
          showAlert(`标记同步状态失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
        setNotionVerificationByEntry(prev => {
          const next = { ...prev };
          delete next[recoveryKey];
          return next;
        });
        await handleSyncNotion(targetIdx, recovery.todoIds);
      },
    });
  };


  const reviewList = useMemo(() => {
    return history.map((item, originalIndex) => ({ ...item, originalIndex })).filter(item => {
      const isReviewed = !!item.reviewed;
      if (reviewFilterUnreviewed && reviewFilterReviewed) return true;
      if (reviewFilterUnreviewed && !reviewFilterReviewed) return !isReviewed;
      if (!reviewFilterUnreviewed && reviewFilterReviewed) return isReviewed;
      return false;
    }).sort((a, b) => {
      const timeA = a.emailDate ? new Date(a.emailDate).getTime() : a.timestamp;
      const timeB = b.emailDate ? new Date(b.emailDate).getTime() : b.timestamp;
      return timeB - timeA;
    });
  }, [history, reviewFilterUnreviewed, reviewFilterReviewed]);

  const toggleReviewed = useCallback(async (originalIndex: number, targetStatus?: boolean) => {
    const newHistory = [...history];
    const current = newHistory[originalIndex];
    if (!current) return;
    const nextStatus = targetStatus !== undefined ? targetStatus : !current.reviewed;
    newHistory[originalIndex] = { ...current, reviewed: nextStatus };
    setHistory(newHistory);
    await historyStore.set('history', newHistory);
    await historyStore.save();
  }, [history]);

  useEffect(() => {
    if (!inReviewMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const currentItem = reviewList[reviewIndex];
      if (e.key === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        if (currentItem) {
          toggleReviewed(currentItem.originalIndex, true);
          if (reviewFilterReviewed) {
            if (reviewIndex < reviewList.length - 1) {
              setReviewIndex(reviewIndex + 1);
            }
          } else {
            if (reviewIndex >= reviewList.length - 1 && reviewIndex > 0) {
              setReviewIndex(reviewIndex - 1);
            }
          }
        }
      } else if (e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (reviewIndex < reviewList.length - 1) {
          setReviewIndex(reviewIndex + 1);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (reviewIndex > 0) {
          setReviewIndex(reviewIndex - 1);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setInReviewMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [inReviewMode, reviewFilterReviewed, reviewIndex, reviewList, toggleReviewed]);

  useEffect(() => {
    setActiveTab('todos');
    setPreviewDrawerOpen(false);
    setSelectedText('');
    setSelectionSource('');
  }, [reviewIndex, inReviewMode]);

  const { grouped, folders } = useMemo(() => {
    const indexedHistory = history.map((item, originalIndex) => ({ ...item, originalIndex }));
    const sorted = [...indexedHistory].sort((a, b) => {
      const timeA = a.emailDate ? new Date(a.emailDate).getTime() : a.timestamp;
      const timeB = b.emailDate ? new Date(b.emailDate).getTime() : b.timestamp;
      return timeB - timeA;
    });

    const g: Record<string, Record<string, typeof sorted>> = {};
    sorted.forEach(item => {
      const folderName = item.folder ? decodeIMAPFolder(item.folder) : '未知目录';
      const dateObj = item.emailDate ? new Date(item.emailDate) : new Date(item.timestamp);
      const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;

      if (!g[folderName]) g[folderName] = {};
      if (!g[folderName][dateStr]) g[folderName][dateStr] = [];
      g[folderName][dateStr].push(item);
    });

    return { grouped: g, folders: Object.keys(g) };
  }, [history]);

  useEffect(() => {
    if (folders.length === 0) {
      setSelectedGroup(null);
      return;
    }

    if (selectedGroup && grouped[selectedGroup.folder] && grouped[selectedGroup.folder][selectedGroup.date]) {
      return;
    }

    const firstFolder = folders[0];
    const firstDate = Object.keys(grouped[firstFolder]).sort((a, b) => b.localeCompare(a))[0];
    setSelectedGroup({ folder: firstFolder, date: firstDate });
  }, [grouped, folders, selectedGroup]);

  const getActiveTargetIndex = (customIdx?: number): number | null => {
    if (typeof customIdx === 'number') return customIdx;
    if (editingEntryIndex !== null) return editingEntryIndex;
    if (inReviewMode && reviewList[reviewIndex]) return reviewList[reviewIndex].originalIndex;
    return null;
  };

  const updateTodo = async (todoId: string, field: string, value: any, targetIdx?: number) => {
    const idx = getActiveTargetIndex(targetIdx);
    if (idx === null) return;
    const newHistory = [...history];
    const entry = newHistory[idx];
    if (!entry.aiResult) return;

    entry.aiResult.todos = entry.aiResult.todos.map(t =>
      t.id === todoId ? { ...t, [field]: value } : t
    );
    setHistory(newHistory);
    await historyStore.set('history', newHistory);
    await historyStore.save();
  }

  const handleAddTodo = async (targetIdx?: number) => {
    const idx = getActiveTargetIndex(targetIdx);
    if (idx === null) return;
    const newHistory = [...history];
    const entry = newHistory[idx];
    if (!entry.aiResult) return;

    entry.aiResult.todos.push({
      id: Math.random().toString(36).substring(2, 11),
      selected: true,
      title: '',
      priority: 'Medium',
      planned_date: null
    });
    setHistory(newHistory);
    await historyStore.set('history', newHistory);
    await historyStore.save();
  }

  const persistPositiveFeedbackState = async (
    entry: EmailHistoryItem,
    status: NonNullable<EmailHistoryItem['aiResult']>['positiveFeedbackStatus'],
    fingerprint: string,
    error?: string,
  ) => {
    const updatedAt = Date.now();
    const latestHistory = await historyStore.get<EmailHistoryItem[]>('history') || history;
    const updatedHistory = latestHistory.map((item) => (
      item.emailUid === entry.emailUid && item.timestamp === entry.timestamp && item.aiResult
        ? {
            ...item,
            aiResult: {
              ...item.aiResult,
              positiveFeedbackStatus: status,
              positiveFeedbackFingerprint: fingerprint,
              positiveFeedbackUpdatedAt: updatedAt,
              positiveFeedbackError: error,
            },
          }
        : item
    ));
    setHistory(updatedHistory);
    await historyStore.set('history', updatedHistory);
    await historyStore.save();
  };

  const startPositiveFeedbackLearning = (entry: EmailHistoryItem, snapshot: PositiveFeedbackSnapshot) => {
    void runPositiveFeedbackLearning(snapshot)
      .then((outcome) => persistPositiveFeedbackState(
        entry,
        outcome === 'updated' ? 'completed' : outcome === 'unchanged' ? 'unchanged' : 'skipped',
        snapshot.fingerprint,
      ))
      .catch((error) => persistPositiveFeedbackState(
        entry,
        'failed',
        snapshot.fingerprint,
        error instanceof Error ? error.message : String(error),
      ));
  };

  const retryPositiveFeedbackLearning = async (entry: EmailHistoryItem) => {
    if (!entry.aiResult) return;
    const snapshot = createPositiveFeedbackSnapshot(entry.aiResult.originalTodos || entry.aiResult.todos, entry.aiResult.todos);
    if (!snapshot.changed) return;
    await persistPositiveFeedbackState(entry, 'processing', snapshot.fingerprint);
    startPositiveFeedbackLearning(entry, snapshot);
  };

  const persistVerifiedNotionTodos = async (targetIdx: number, todoIds: string[]) => {
    const entry = history[targetIdx];
    if (!entry?.aiResult) return;

    const todoIdSet = new Set(todoIds);
    for (const todo of entry.aiResult.todos) {
      if (todoIdSet.has(todo.id)) {
        await markNotionSyncVerified(todo);
      }
    }

    const newHistory = [...history];
    const targetEntry = { ...newHistory[targetIdx] };
    let learningSnapshot: PositiveFeedbackSnapshot | null = null;
    let shouldLearn = false;
    if (targetEntry.aiResult) {
      const todos = targetEntry.aiResult.todos.map(todo => (
        todoIdSet.has(todo.id) ? { ...todo, synced: true } : todo
      ));
      const selectedTodos = todos.filter(todo => todo.selected !== false);
      learningSnapshot = createPositiveFeedbackSnapshot(
        targetEntry.aiResult.originalTodos || targetEntry.aiResult.todos,
        todos,
      );
      shouldLearn = shouldStartPositiveFeedbackLearning(targetEntry.aiResult, learningSnapshot);
      targetEntry.aiResult = {
        ...targetEntry.aiResult,
        todos,
        notionSync: resolveNotionSyncTodos(targetEntry.aiResult.notionSync, todoIds),
        ...(shouldLearn
          ? {
              positiveFeedbackStatus: 'processing' as const,
              positiveFeedbackFingerprint: learningSnapshot.fingerprint,
              positiveFeedbackUpdatedAt: Date.now(),
              positiveFeedbackError: undefined,
            }
          : {}),
      };
      targetEntry.syncedToNotion = selectedTodos.length > 0 && selectedTodos.every(todo => todo.synced);
    }
    newHistory[targetIdx] = targetEntry;
    setHistory(newHistory);
    await historyStore.set('history', newHistory);
    await historyStore.save();
    if (shouldLearn && learningSnapshot) startPositiveFeedbackLearning(targetEntry, learningSnapshot);
  }

  const handleSyncNotion = async (targetIdx?: number, forceTodoIds?: string[]) => {
    const idx = getActiveTargetIndex(targetIdx);
    if (idx === null) return;
    const entry = history[idx];
    if (!entry.aiResult || !entry.aiResult.todos) return;

    const recoveryKey = getNotionRecoveryKey(entry, idx);
    if (!forceTodoIds && notionVerificationByEntry[recoveryKey]) {
      openNotionRecoveryDialog(idx, recoveryKey, notionVerificationByEntry[recoveryKey]);
      return;
    }
    if (!forceTodoIds && entry.aiResult.notionSync?.uncertainTodoIds.length) {
      const uncertainIds = entry.aiResult.notionSync.uncertainTodoIds;
      const uncertainTitles = entry.aiResult.todos
        .filter(todo => uncertainIds.includes(todo.id))
        .map(todo => `「${todo.title || todo.id}」`)
        .join('、');
      openNotionRecoveryDialog(idx, recoveryKey, {
        todoIds: uncertainIds,
        message: `以下待办的 Notion 推送结果无法确认：${uncertainTitles || '部分待办'}。\n\n${entry.aiResult.notionSync.lastError || ''}\n\n请先在 Notion 中核对：如果页面已存在，请标记为已同步；如果确认未创建，再强制重试。强制重试可能产生重复页面。`,
      });
      return;
    }

    const positiveFeedbackSnapshot = createPositiveFeedbackSnapshot(
      entry.aiResult.originalTodos || entry.aiResult.todos,
      entry.aiResult.todos,
    );
    const shouldLearnAfterSync = shouldStartPositiveFeedbackLearning(entry.aiResult, positiveFeedbackSnapshot);
    const forceIdSet = forceTodoIds ? new Set(forceTodoIds) : null;
    const selectedTodos = entry.aiResult.todos.filter(todo => (
      todo.selected !== false &&
      !todo.synced &&
      (!forceIdSet || forceIdSet.has(todo.id))
    ));
    const todosToSync = forceTodoIds
      ? selectedTodos.filter(todo => forceTodoIds.includes(todo.id))
      : selectedTodos;
    if (todosToSync.length === 0) {
      showAlert("当前没有可同步的待办事项：您选中的条目可能已全部同步至 Notion，或未勾选任何有效事项。");
      return;
    }

    setSyncing(true);
    const syncingEntry = { ...entry, aiResult: {
      ...entry.aiResult,
      notionSync: createNotionSyncInProgressState(
        todosToSync.length,
        todosToSync.map(todo => todo.id),
      ),
    }};
    const syncingHistory = [...history];
    syncingHistory[idx] = syncingEntry;
    setHistory(syncingHistory);
    try {
      const syncRes = await syncToNotion(
        todosToSync,
        forceTodoIds ? { forceTodoIds } : undefined,
      );
      const succeeded = syncRes.filter(r => r.success);
      const failed = syncRes.filter(r => !r.success);
      const uncertainResults = failed.filter(result => result.needsVerification);

      const newHistory = [...history];
      const targetEntry = { ...newHistory[idx] };
      if (targetEntry.aiResult) {
        const succeededIds = new Set(succeeded.map(result => result.id));
        const todos = targetEntry.aiResult.todos.map(todo => (
          succeededIds.has(todo.id) ? { ...todo, synced: true } : todo
        ));
        const selectedHistoryTodos = todos.filter(todo => todo.selected !== false);
        const shouldTrackLearning = shouldLearnAfterSync && succeeded.length > 0;
        targetEntry.aiResult = {
          ...targetEntry.aiResult,
          todos,
          notionSync: summarizeNotionSyncResults(syncRes, todosToSync.length),
          ...(shouldTrackLearning
            ? {
                positiveFeedbackStatus: uncertainResults.length > 0 ? 'pending_verification' as const : 'processing' as const,
                positiveFeedbackFingerprint: positiveFeedbackSnapshot.fingerprint,
                positiveFeedbackUpdatedAt: Date.now(),
                positiveFeedbackError: undefined,
              }
            : {}),
        };
        targetEntry.syncedToNotion = selectedHistoryTodos.length > 0 && selectedHistoryTodos.every(todo => todo.synced);
      }
      newHistory[idx] = targetEntry;

      setHistory(newHistory);
      await historyStore.set('history', newHistory);
      await historyStore.save();

      if (shouldLearnAfterSync && succeeded.length > 0 && uncertainResults.length === 0) {
        startPositiveFeedbackLearning(entry, positiveFeedbackSnapshot);
      }

      if (uncertainResults.length > 0) {
        const uncertainIds = uncertainResults.map(result => result.id);
        const uncertainTitles = todosToSync
          .filter(todo => uncertainIds.includes(todo.id))
          .map(todo => `「${todo.title || todo.id}」`)
          .join('、');
        const errorMsgs = failed.map(result => `条目错误: ${result.error}`).join('\n');

        openNotionRecoveryDialog(idx, recoveryKey, {
          todoIds: uncertainIds,
          message: `上次 Notion 推送结果未知：${uncertainTitles || '部分待办'}。\n\n${errorMsgs}\n\n请先在 Notion 中核对。若页面已存在，请标记为已同步；若确认未创建，再强制重试。强制重试可能产生重复页面。`,
        });
        return;
      }

      if (failed.length > 0) {
        const errorMsgs = failed.map(result => `条目错误: ${result.error}`).join('\n');
        showAlert(`部分同步失败 (${failed.length}/${todosToSync.length}):\n${errorMsgs}`);
      }
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : e.message || String(e);
      const failedEntry = { ...entry, aiResult: {
        ...entry.aiResult,
        notionSync: createNotionSyncFailureState(
          todosToSync.length,
          todosToSync.map(todo => todo.id),
          msg,
        ),
      }};
      const failedHistory = [...history];
      failedHistory[idx] = failedEntry;
      setHistory(failedHistory);
      await historyStore.set('history', failedHistory);
      await historyStore.save();
      console.error(e);
      showAlert('同步失败: ' + msg);
    } finally {
      setSyncing(false);
    }
  }

  const handleExplicitFeedback = async (idx: number) => {
    const entry = history[idx];
    if (!entry.aiResult) return;
    const originalTodosToUse = entry.aiResult.originalTodos || entry.aiResult.todos || [];
    const feedbackType = getFeedbackType(originalTodosToUse.length);

    // 1. Immediately set UI and Store to 'processing'
    try {
      const newHistory = [...history];
      newHistory[idx].aiResult = {
        ...newHistory[idx].aiResult!,
        feedbackStatus: 'processing',
        explicitFeedback: feedbackText,
        feedbackType,
      };
      setHistory(newHistory);
      await historyStore.set('history', newHistory);
      await historyStore.save();
    } catch (e) {
      console.error("Failed to update processing status in history", e);
    }

    try {
      // 2. Call AI
      const m = await import('./lib/autoOptimize');
      await m.backgroundReviewAndUpdateFocus(originalTodosToUse, [], feedbackText, feedbackType);

      // 3. Update store to 'completed'
      try {
        const latestHistory = await historyStore.get<EmailHistoryItem[]>('history') || [];
        const updatedIdx = latestHistory.findIndex(h => h.timestamp === entry.timestamp && h.emailUid === entry.emailUid);
        if (updatedIdx !== -1 && latestHistory[updatedIdx].aiResult) {
            latestHistory[updatedIdx].aiResult!.feedbackStatus = 'completed';
            latestHistory[updatedIdx].aiResult!.feedbackType = feedbackType;
            latestHistory[updatedIdx].aiResult!.isRejected = feedbackType === 'over_extraction';
            setHistory(latestHistory);
            await historyStore.set('history', latestHistory);
            await historyStore.save();
        }
      } catch (e) {
        console.error("Failed to update completed status in history", e);
      }

      // 4. Close only the feedback form. Do not change Notion delivery state.
      setTimeout(() => {
        if (feedbackEntryIdx === idx) {
          setFeedbackEntryIdx(null);
          setFeedbackText('');
        }
      }, 1500);

    } catch (e) {
      console.error(e);
      // Fallback: remove processing status
    }
  };

  const toggleExpand = (key: string) => {
    setExpandedTodos(prev => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    loadHistory();
  }, [historyVersion]);

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

  const clearAllHistory = async () => {
    setConfirmDialog({
      isOpen: true,
      message: '确定要清空所有邮箱监听历史记录并重置底层的防重复指纹吗？清空后，之前时间范围内的邮件将被重新抓取。',
      onConfirm: async () => {
        try {
          await historyStore.set('history', []);
          await historyStore.set('processed_uids', []);
          await historyStore.save();
          setHistory([]);
        } catch (e) {
          console.error("清空历史记录失败", e);
        }
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
      }
    });
  }

  const removeHistoryItem = async (indexToRemove: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDialog({
      isOpen: true,
      message: '确定要删除这条记录吗？删除后该邮件将在下次扫描时重新被抓取。',
      onConfirm: async () => {
        const entryToRemove = history[indexToRemove];
        const newHistory = history.filter((_, idx) => idx !== indexToRemove);

        try {
          let processedUids: string[] = await historyStore.get('processed_uids') || [];
          processedUids = processedUids.filter(uidStr => !uidStr.endsWith(`_${entryToRemove.emailUid}`));
          await historyStore.set('processed_uids', processedUids);

          await historyStore.set('history', newHistory);
          await historyStore.save();
          setHistory(newHistory);
        } catch (err) {
          console.error("删除记录失败", err);
        }
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
      }
    });
  }

  const handleForceRun = async () => {
    if (running) return;
    try {
      await forceRunEmailScanner(true);
      await loadHistory();
    } catch (e) {
      console.error(e);
    }
  }

  if (inReviewMode) {
    const currentReviewItem = reviewList[reviewIndex];
    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-200 p-4 sm:p-8">
        <div className={`glass-panel flex flex-col shadow-2xl border border-pink-500/30 overflow-hidden ${isWindowMode ? 'w-full max-w-6xl h-[95vh] rounded-2xl' : 'w-[95%] max-w-[960px] h-[90vh] rounded-xl'}`}>

          {/* Top Header of Review Mode */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-slate-900/80 border-b border-white/10 gap-3 shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-white flex items-center gap-2">
                <Rocket className="w-5 h-5 text-pink-400 animate-pulse" />
                逐条审核模式
              </span>
              <span className="text-xs text-slate-400 font-mono bg-white/5 px-2.5 py-1 rounded-full">
                进度: {reviewList.length > 0 ? reviewIndex + 1 : 0} / {reviewList.length}
              </span>
            </div>

            {/* Multi-select Checkboxes */}
            <div className="flex items-center gap-4 bg-black/40 px-3 py-1.5 rounded-lg border border-white/5 text-xs">
              <span className="text-slate-400">过滤显示:</span>
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-200 hover:text-white select-none">
                <input
                  type="checkbox"
                  checked={reviewFilterUnreviewed}
                  onChange={(e) => {
                    setReviewFilterUnreviewed(e.target.checked);
                    setReviewIndex(0);
                  }}
                  className="rounded border-slate-600 bg-slate-800 text-pink-500 focus:ring-0 w-3.5 h-3.5"
                />
                未审核
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-200 hover:text-white select-none">
                <input
                  type="checkbox"
                  checked={reviewFilterReviewed}
                  onChange={(e) => {
                    setReviewFilterReviewed(e.target.checked);
                    setReviewIndex(0);
                  }}
                  className="rounded border-slate-600 bg-slate-800 text-pink-500 focus:ring-0 w-3.5 h-3.5"
                />
                已审核
              </label>
            </div>

            <button
              onClick={() => setInReviewMode(false)}
              className="text-xs bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 self-end sm:self-auto"
            >
              <X className="w-4 h-4" /> 退出逐条模式 (Esc)
            </button>
          </div>

          {/* Body content of Review Mode */}
          <div className="flex-1 overflow-hidden p-6 bg-slate-950/40 flex flex-col justify-between">
            {reviewList.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-2 my-auto">
                <CheckCircle2 className="w-12 h-12 text-slate-600 mb-2" />
                <p className="text-base">当前勾选的过滤条件下暂无邮件记录</p>
                <p className="text-xs text-slate-600">请尝试勾选右上角的“未审核”或“已审核”查看更多内容</p>
              </div>
            ) : currentReviewItem ? (
              <div className={`flex flex-col gap-4 mx-auto w-full flex-1 overflow-hidden ${isWindowMode ? 'max-w-7xl' : 'max-w-4xl'}`}>
                {/* Email Metadata Card */}
                <div className="bg-slate-900/60 border border-white/10 rounded-xl p-5 shadow-lg flex flex-col gap-3 shrink-0">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <span className="text-xs font-semibold text-pink-400 bg-pink-500/10 px-2.5 py-1 rounded-md border border-pink-500/20 mb-2 inline-block">
                        {currentReviewItem.folder ? decodeIMAPFolder(currentReviewItem.folder) : 'INBOX'}
                      </span>
                      <h3 className="text-lg font-bold text-white mt-1">{currentReviewItem.subject || '(无主题)'}</h3>
                    </div>
                    <button
                      onClick={() => toggleReviewed(currentReviewItem.originalIndex)}
                      className={`h-6 px-2.5 py-0.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all border shrink-0 ${
                        currentReviewItem.reviewed
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 shadow-sm shadow-emerald-500/10'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25'
                      }`}
                    >
                      {currentReviewItem.reviewed ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <Clock className="w-3.5 h-3.5 shrink-0" />}
                      {currentReviewItem.reviewed ? '已审核 (点击人工解除)' : '未审核 (点击手动标记)'}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 border-t border-white/5 pt-3 mt-1 font-mono">
                    <span>发件人: <strong className="text-slate-300 font-sans">{currentReviewItem.sender}</strong></span>
                    <span>时间: {currentReviewItem.emailDate ? new Date(currentReviewItem.emailDate).toLocaleString() : new Date(currentReviewItem.timestamp).toLocaleString()}</span>
                    <span>状态: <span className={currentReviewItem.status === 'success' ? 'text-emerald-400' : 'text-red-400'}>{currentReviewItem.status === 'success' ? '解析成功' : '解析失败'}</span></span>
                    {currentReviewItem.status === 'failed' && currentReviewItem.retryable === false && (
                      <span className="text-amber-300">需检查服务商或 Notion 配置；修复后可手动扫描重试，若提示结果未知请先在 Notion 人工核对</span>
                    )}
                  </div>
                </div>

                {/* Unified Feature-Parity Review Content */}
                <div className="flex-1 overflow-hidden flex flex-col mt-1">
                  {renderEmailDetailsContent(currentReviewItem, currentReviewItem.originalIndex)}
                </div>
              </div>
            ) : null}
          </div>

          {/* Ergonomic Bottom Control Bar */}
          <div className="p-4 bg-slate-900 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (reviewIndex > 0) setReviewIndex(reviewIndex - 1);
                }}
                disabled={reviewIndex <= 0 || reviewList.length === 0}
                className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white disabled:opacity-30 disabled:pointer-events-none text-xs font-medium transition-all flex items-center gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" /> 返回上一条 (←/P)
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  if (reviewIndex < reviewList.length - 1) setReviewIndex(reviewIndex + 1);
                }}
                disabled={reviewIndex >= reviewList.length - 1 || reviewList.length === 0}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white disabled:opacity-30 disabled:pointer-events-none text-xs font-medium transition-all flex items-center gap-1.5 border border-white/5"
              >
                跳过不标记，下一条 (→/N) <ArrowRight className="w-4 h-4" />
              </button>

              <button
                onClick={() => {
                  if (currentReviewItem) {
                    toggleReviewed(currentReviewItem.originalIndex, true);
                    if (reviewFilterReviewed) {
                      if (reviewIndex < reviewList.length - 1) setReviewIndex(reviewIndex + 1);
                    } else {
                      if (reviewIndex >= reviewList.length - 1 && reviewIndex > 0) {
                        setReviewIndex(reviewIndex - 1);
                      }
                    }
                  }
                }}
                disabled={reviewList.length === 0}
                className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white font-medium text-xs shadow-lg shadow-pink-500/20 transition-all flex items-center gap-2 disabled:opacity-30 disabled:pointer-events-none"
              >
                <CheckCircle2 className="w-4 h-4" /> 标记已审并查看下一条 (Enter/Space)
              </button>
            </div>
          </div>

        </div>
      </div>
    );
  }

  function renderEmailDetailsContent(entry: EmailHistoryItem, entryIndex: number) {
    const result = entry.aiResult;
    const notionStatus = result?.notionSync?.status || (entry.syncedToNotion ? 'success' : 'idle');
    const notionStatusLabel = getNotionSyncStatusLabel(result?.notionSync) || (entry.syncedToNotion ? '已同步' : undefined);
    const recoveryKey = getNotionRecoveryKey(entry, entryIndex);
    const hasPendingVerification = !!notionVerificationByEntry[recoveryKey] || notionStatus === 'needs_verification';
    const notionButtonLabel = getNotionSyncButtonLabel(result?.notionSync, hasPendingVerification, !!entry.syncedToNotion);
    const notionStatusClass = notionStatus === 'success'
      ? 'bg-green-500/15 text-green-300 border-green-500/30'
      : notionStatus === 'needs_verification'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : notionStatus === 'partial_failed'
          ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
          : notionStatus === 'failed'
            ? 'bg-red-500/15 text-red-300 border-red-500/30'
            : 'bg-slate-500/15 text-slate-300 border-slate-500/30';
    const parsedThread = parseEmailThread(entry.htmlBody || entry.rawBodyText || '', !!entry.htmlBody);
    return (
      <>
        {/* Dual Tab Switcher */}
          <div className="flex border-b border-white/10 shrink-0 gap-6">
            <button
              onClick={() => setActiveTab('todos')}
              className={`pb-2 text-sm font-medium border-b-2 transition-all flex items-center gap-1.5 ${activeTab === 'todos' ? 'border-pink-500 text-pink-400 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-300'}`}
            >
              <span>📋</span> 待办处理 ({result?.todos?.length || 0})
            </button>
            <button
              onClick={() => setActiveTab('original')}
              className={`pb-2 text-sm font-medium border-b-2 transition-all flex items-center gap-1.5 ${activeTab === 'original' ? 'border-pink-500 text-pink-400 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-300'}`}
            >
              <span>📧</span> 邮件原文与图片 ({entry.inlineImages?.length || 0}图)
            </button>
          </div>

          <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
            {result ? (
              activeTab === 'todos' ? (
                <div className="space-y-4">
                  {/* Layered Summary Card */}
                  <div className="bg-slate-900/50 p-4 rounded-lg border border-white/5 relative">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-slate-200 flex items-center gap-1.5">
                        <span>✨</span> 智能分析摘要
                      </h3>
                      <button
                        onClick={() => setPreviewDrawerOpen(!previewDrawerOpen)}
                        className="text-xs text-pink-400 hover:text-pink-300 flex items-center gap-1 bg-pink-500/10 hover:bg-pink-500/20 px-2.5 py-1 rounded transition-colors border border-pink-500/20"
                      >
                        <span>📧 展开邮件速览</span>
                        {previewDrawerOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {previewDrawerOpen && (
                      <div className="mb-3 p-3 bg-black/50 rounded border border-white/10 text-xs text-slate-300 max-h-40 overflow-y-auto custom-scrollbar whitespace-pre-wrap font-mono">
                        <div className="text-pink-400 mb-1 font-sans font-semibold flex items-center justify-between">
                          <span>【邮件正文速览】</span>
                          <span className="text-slate-500 font-normal">共 {(entry.rawBodyText || '').length} 字</span>
                        </div>
                        {entry.rawBodyText || '(无文本正文)'}
                      </div>
                    )}

                    {result.key_points && result.key_points.length > 0 && (
                      <div className="mb-3 bg-purple-500/5 p-3 rounded border border-purple-500/10">
                        <div className="text-xs font-semibold text-purple-300 mb-2 flex items-center gap-1">
                          <span>📌</span> 核心要点与背景依赖：
                        </div>
                        <ul className="space-y-1.5 pl-1">
                          {result.key_points.map((kp, kpIdx) => (
                            <li key={kpIdx} className="text-xs text-slate-300 flex items-start gap-2">
                              <span className="text-purple-400 font-bold shrink-0">{kpIdx + 1}.</span>
                              <span className="leading-relaxed">{kp}</span>
                            </li>
                          ))}
                        </ul>
                        <hr className="border-white/10 my-3" />
                      </div>
                    )}

                    <div className="text-xs font-semibold text-slate-400 mb-1">【总体概括】</div>
                    <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{result.summary}</p>
                  </div>

                  <FeedbackHistoryCard
                    feedbackStatus={result.feedbackStatus}
                    feedbackType={result.feedbackType}
                    explicitFeedback={result.explicitFeedback}
                    isRejected={result.isRejected}
                  />

                  {/* Todo list */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-medium text-slate-200">待办事项</h3>
                    {result.todos.map((todo) => (
                      <div key={todo.id} className="bg-slate-900/50 p-3 rounded-lg border border-white/5 flex gap-3 overflow-x-auto custom-scrollbar">
                        <div className="flex items-center justify-center h-7 shrink-0">
                          <input
                            type="checkbox"
                            checked={todo.selected !== false}
                            onChange={(e) => updateTodo(todo.id, 'selected', e.target.checked, entryIndex)}
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
                                onChange={(e) => updateTodo(todo.id, field.name, e.target.value, entryIndex)}
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
                                onChange={(e) => updateTodo(todo.id, field.name, e.target.value, entryIndex)}
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
                                  onChange={e => updateTodo(todo.id, field.name, e.target.checked, entryIndex)}
                                  disabled={entry.syncedToNotion}
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
                                onChange={e => updateTodo(todo.id, field.name, e.target.value, entryIndex)}
                                disabled={entry.syncedToNotion}
                                placeholder={field.name}
                                className="flex-1 min-w-[120px] bg-transparent text-xs border-b border-white/10 focus:border-purple-500/50 outline-none text-slate-300 px-1"
                              />
                            );
                          }
                        })}
                      </div>
                    ))}

                    {!entry.syncedToNotion && (
                      <button
                        onClick={() => handleAddTodo(entryIndex)}
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
                          onClick={() => setFeedbackEntryIdx(feedbackEntryIdx === entryIndex ? null : entryIndex)}
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
                            onClick={() => handleSyncNotion(entryIndex)}
                            disabled={syncing || (result.todos.filter(todo => todo.selected !== false && !todo.synced).length === 0 && !hasPendingVerification) || entry.syncedToNotion || result.feedbackStatus === 'processing' || result.feedbackStatus === 'completed'}
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
                        <button onClick={() => retryPositiveFeedbackLearning(entry)} className="px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30">重试</button>
                      </div>
                    )}

                    {feedbackEntryIdx === entryIndex && canProvideExplicitFeedback(result.feedbackStatus) && (
                      <div className="animate-in fade-in slide-in-from-top-2 bg-slate-900/80 border border-red-500/30 p-4 rounded-lg flex flex-col gap-3">
                        <p className="text-xs text-slate-400">
                          {result.todos.length === 0
                            ? <>本封邮件<strong className="text-amber-300">没有提取出待办</strong>。请补充被遗漏的行动项、常见表达或截止时间线索，系统会将其作为<strong className="text-amber-300">漏提取样本</strong>交给 AI 学习。</>
                            : <>请简单说明原因，系统会将本次所有提取结果作为<span className="text-red-400">反面教材</span>发给 AI 深度学习，并废弃当前结果。</>}
                        </p>
                        <textarea
                          value={feedbackText}
                          onChange={e => setFeedbackText(e.target.value)}
                          placeholder={result.todos.length === 0
                            ? '例如：“请在周五前确认报价”应识别为待办；看到“请确认 / 跟进 / 提交 / 截止”要提取。'
                            : '（可选）吐槽一下，例如：不要提取没有明确动作的废话'}
                          className="w-full bg-black/50 border border-white/10 rounded-md p-2 text-sm text-slate-300 focus:outline-none focus:border-red-500/50 min-h-[60px]"
                        />
                        <div className="flex justify-end">
                          <button
                            onClick={() => handleExplicitFeedback(entryIndex)}
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
                </div>
              ) : (
                <div
                  className="space-y-4"
                  onMouseUp={() => {
                    const sel = window.getSelection()?.toString().trim() || '';
                    if (sel.length > 0) {
                      setSelectedText(sel);
                    }
                  }}
                >
                  {selectedText && (
                    <div className="sticky top-0 z-20 bg-purple-900/95 border border-purple-500 p-3 rounded-lg shadow-2xl backdrop-blur flex items-center justify-between gap-3 animate-in fade-in duration-200">
                      <div className="flex-1 overflow-hidden">
                        <div className="text-xs font-semibold text-purple-200 mb-0.5">已划选文字 ({selectedText.length}字):</div>
                        <div className="text-xs text-white truncate font-mono bg-black/40 px-2 py-1 rounded">{selectedText}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={async () => {
                          const newHistory = [...history];
                          const curEntry = newHistory[entryIndex];
                          if (curEntry && curEntry.aiResult) {
                              const activeFields = notionProperties?.filter(p => fieldMappings[p.id]?.enabled) || [];
                              const titleProp = activeFields.find(p => p.type === 'title')?.name || 'title';
                              const sourceTag = selectionSource ? ` [${selectionSource}]` : '';
                              const newTodo: any = {
                                id: Math.random().toString(36).substring(2, 11),
                                selected: true,
                                [titleProp]: (selectedText.length > 50 ? selectedText.substring(0, 50) + '...' : selectedText) + sourceTag,
                                备注: selectedText + (selectionSource ? `\n(数据来源：${selectionSource})` : '')
                              };
                              curEntry.aiResult.todos.push(newTodo);
                              setHistory(newHistory);
                              await historyStore.set('history', newHistory);
                              await historyStore.save();
                              setSelectedText('');
                              setSelectionSource('');
                              setActiveTab('todos');
                            }
                          }}
                          className="bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1 shadow-lg transition-all active:scale-95 border border-purple-400"
                        >
                          <span>➕ 从划选生成待办</span>
                        </button>
                        <button
                          onClick={() => {
                            setSelectedText('');
                            setSelectionSource('');
                          }}
                          className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="bg-slate-900/50 p-4 rounded-lg border border-white/5 space-y-4">
                    <div>
                      <h3 className="text-xs font-semibold text-slate-400 mb-2 border-b border-white/10 pb-1">发件人与基本信息</h3>
                      <div className="text-xs text-slate-300 space-y-1">
                        <div><span className="text-slate-500">发件人:</span> {entry.sender}</div>
                        <div><span className="text-slate-500">主　题:</span> {entry.subject}</div>
                        {entry.emailDate && <div><span className="text-slate-500">收件时间:</span> {new Date(entry.emailDate).toLocaleString()}</div>}
                      </div>
                    </div>

                    {entry.inlineImages && entry.inlineImages.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-slate-400 mb-2 border-b border-white/10 pb-1">邮件附带图片 ({entry.inlineImages.length}张 - 点击看大图)</h3>
                        <div className="grid grid-cols-3 gap-2">
                          {entry.inlineImages.map((img, imgIdx) => (
                            <div
                              key={imgIdx}
                              onClick={() => setLightboxImg(img)}
                              className="aspect-video bg-black/40 rounded border border-white/10 overflow-hidden cursor-pointer group relative flex items-center justify-center"
                            >
                              <img src={img} alt={`附图 ${imgIdx + 1}`} className="max-w-full max-h-full object-contain group-hover:scale-105 transition-transform duration-200" />
                              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs text-white font-medium">
                                🔍 点击高清放大
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="flex items-center justify-between mb-2 border-b border-white/10 pb-2">
                        <h3 className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                          <span>📄</span> 邮件完整内容 (鼠标拖拽选择文字即可生成待办)
                        </h3>
                        <button
                          onClick={() => setEmailViewMode(prev => prev === 'light' ? 'dark' : 'light')}
                          className={`text-xs px-3 py-1 rounded-full border transition-all flex items-center gap-1.5 shadow-sm ${
                            emailViewMode === 'light'
                              ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20'
                              : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20'
                          }`}
                        >
                          <span>{emailViewMode === 'light' ? '☀️ 护眼白底模式 (默认)' : '🌙 深色纯净模式'}</span>
                          <span className="text-[10px] opacity-70">点击切换</span>
                        </button>
                      </div>

                      {parsedThread.hasHistory ? (
                        <div className="space-y-4">
                          {/* 降噪数据统计条与一键控制栏 */}
                          <div className="p-3 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-between text-xs shadow-sm">
                            <div className="flex items-center gap-2 text-indigo-200">
                              <span className="flex h-2 w-2 rounded-full bg-indigo-400 animate-pulse" />
                              <span>
                                📉 智能降噪：已自动折叠 <strong className="text-white font-semibold">{parsedThread.historicalThreads.length}</strong> 封往期会话，释放约 <strong className="text-white font-semibold">{parsedThread.reducedWords}</strong> 字冗余排版
                              </span>
                            </div>
                            <button
                              onClick={() => {
                                const allOpen = parsedThread.historicalThreads.every(h => expandedThreads[h.index]);
                                const nextState: Record<number, boolean> = {};
                                parsedThread.historicalThreads.forEach(h => {
                                  nextState[h.index] = !allOpen;
                                });
                                setExpandedThreads(nextState);
                              }}
                              className="px-3 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 hover:text-white transition-colors flex items-center gap-1.5 font-medium border border-indigo-500/30 shrink-0"
                            >
                              <span>{parsedThread.historicalThreads.every(h => expandedThreads[h.index]) ? '⏫ 收起全部历史' : '⏬ 展开全部历史'}</span>
                            </button>
                          </div>

                          {/* 置顶高亮：本次发信/最新回复正文 */}
                          <div
                            className={`rounded-xl overflow-hidden border shadow-lg ${
                              emailViewMode === 'light'
                                ? 'border-amber-400/60 bg-white'
                                : 'border-indigo-500/40 bg-slate-900/90'
                            }`}
                            onMouseUp={() => setSelectionSource('最新发信正文')}
                          >
                            <div className={`px-4 py-2.5 border-b flex items-center justify-between text-xs font-medium ${
                              emailViewMode === 'light'
                                ? 'bg-amber-50/90 border-amber-200 text-amber-900'
                                : 'bg-indigo-950/70 border-indigo-500/30 text-indigo-200'
                            }`}>
                              <span className="flex items-center gap-2 font-bold">
                                <span className={`px-2 py-0.5 rounded text-[11px] font-extrabold ${
                                  emailViewMode === 'light' ? 'bg-amber-500 text-white shadow-sm' : 'bg-indigo-500 text-white shadow-sm'
                                }`}>核心正文</span>
                                本次发信 / 最新回复 (权重 100%)
                              </span>
                              <span className="opacity-75">拖拽选词可生成优先待办</span>
                            </div>
                            {entry.htmlBody ? (
                              <div
                                className={`p-6 text-sm leading-relaxed overflow-x-auto custom-scrollbar select-text min-h-[160px] ${
                                  emailViewMode === 'light' ? 'text-slate-900 bg-white' : 'text-slate-200 bg-slate-950/50 prose prose-invert max-w-none'
                                }`}
                                dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(parsedThread.latestMessage) }}
                              />
                            ) : (
                              <pre className={`p-6 text-sm leading-relaxed whitespace-pre-wrap font-sans select-text min-h-[160px] ${
                                emailViewMode === 'light' ? 'text-slate-900 bg-white' : 'text-slate-200 bg-slate-950/50'
                              }`}>
                                {parsedThread.latestMessage || '(空文本)'}
                              </pre>
                            )}
                          </div>

                          {/* 手风琴历史会话矩阵 */}
                          <div className="space-y-2.5 pt-2">
                            <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 px-1">
                              <span>📚 往期转发与引用回帖链 (共 {parsedThread.historicalThreads.length} 封)</span>
                              <span className="h-px flex-1 bg-white/10"></span>
                            </div>
                            {parsedThread.historicalThreads.map((thread) => {
                              const isExpanded = !!expandedThreads[thread.index];
                              return (
                                <div
                                  key={thread.index}
                                  className={`rounded-xl overflow-hidden border transition-all duration-200 ${
                                    emailViewMode === 'light'
                                      ? 'border-slate-300 bg-slate-50 shadow-sm'
                                      : 'border-white/10 bg-slate-900/70'
                                  }`}
                                  onMouseUp={() => setSelectionSource(`引自历史回帖 #${thread.index + 1}`)}
                                >
                                  {/* 手风琴头部 */}
                                  <div
                                    onClick={() => setExpandedThreads(prev => ({ ...prev, [thread.index]: !prev[thread.index] }))}
                                    className={`px-4 py-3 flex items-center justify-between cursor-pointer select-none transition-colors ${
                                      emailViewMode === 'light'
                                        ? 'hover:bg-slate-200/80 bg-slate-100/90 text-slate-700'
                                        : 'hover:bg-white/5 bg-black/40 text-slate-300'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                      <span className={`text-xs px-2 py-0.5 rounded font-mono font-bold shrink-0 ${
                                        emailViewMode === 'light' ? 'bg-slate-300 text-slate-800' : 'bg-white/10 text-indigo-300'
                                      }`}>
                                        #{thread.index + 1}
                                      </span>
                                      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                                        <div className="flex items-center gap-2 text-xs font-semibold">
                                          <span className="truncate text-slate-200">{thread.sender || '往期发件人'}</span>
                                          {thread.sendTime && (
                                            <span className="text-[11px] opacity-70 shrink-0 font-normal text-slate-400">({thread.sendTime})</span>
                                          )}
                                        </div>
                                        {thread.subject && (
                                          <div className="text-[11px] opacity-75 truncate font-normal text-slate-400">
                                            主题: {thread.subject}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0 pl-2">
                                      <span className="text-[10px] opacity-60 font-mono px-1.5 py-0.5 rounded bg-white/5">{thread.wordCount} 字</span>
                                      <span className="text-sm">{isExpanded ? '🔽' : '▶️'}</span>
                                    </div>
                                  </div>

                                  {/* 手风琴展开内容 */}
                                  {isExpanded && (
                                    <div className={`border-t ${emailViewMode === 'light' ? 'border-slate-200 bg-white' : 'border-white/10 bg-slate-950/60'}`}>
                                      {entry.htmlBody ? (
                                        <div
                                          className={`p-5 text-sm leading-relaxed overflow-x-auto custom-scrollbar select-text ${
                                            emailViewMode === 'light' ? 'text-slate-800' : 'text-slate-300 prose prose-invert max-w-none'
                                          }`}
                                          dangerouslySetInnerHTML={{
                                            __html: sanitizeEmailHtml(thread.content)
                                          }}
                                        />
                                      ) : (
                                        <pre className={`p-5 text-sm leading-relaxed whitespace-pre-wrap font-sans select-text ${
                                          emailViewMode === 'light' ? 'text-slate-800' : 'text-slate-300'
                                        }`}>
                                          {thread.content}
                                        </pre>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        /* 无历史回帖时的普通单卡片原貌渲染 */
                        emailViewMode === 'light' ? (
                          <div
                            className="rounded-xl overflow-hidden border border-white/20 shadow-2xl bg-slate-100"
                            onMouseUp={() => setSelectionSource('邮件正文')}
                          >
                            <div className="bg-slate-200/90 px-4 py-2 border-b border-slate-300 flex items-center justify-between text-xs text-slate-700 font-medium">
                              <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                                <span>💡</span> 当前为安全白底阅读，已保留文字与表格，外部图片和不安全排版已屏蔽
                              </span>
                              <span className="text-slate-500">拖拽选词后可一键添加待办</span>
                            </div>
                            {entry.htmlBody ? (
                              <div
                                className="p-6 text-sm text-slate-900 leading-relaxed overflow-x-auto custom-scrollbar select-text bg-white min-h-[260px]"
                                dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(entry.htmlBody) }}
                              />
                            ) : (
                              <pre className="p-6 text-sm text-slate-900 leading-relaxed whitespace-pre-wrap font-sans select-text bg-white min-h-[260px]">
                                {entry.rawBodyText || '(空文本)'}
                              </pre>
                            )}
                          </div>
                        ) : (
                          <div
                            className="rounded-xl overflow-hidden border border-white/10 shadow-xl bg-slate-900/90"
                            onMouseUp={() => setSelectionSource('邮件正文')}
                          >
                            <div className="bg-black/40 px-4 py-2 border-b border-white/5 flex items-center justify-between text-xs text-slate-400 font-medium">
                              <span className="flex items-center gap-1.5 text-indigo-300">
                                <span>🌙</span> 当前为安全深色阅读，已保留文字与表格，外部图片和不安全排版已屏蔽
                              </span>
                              <span className="text-slate-500">拖拽选词后可一键添加待办</span>
                            </div>
                            {entry.htmlBody ? (
                              <div
                                className="p-6 text-sm text-slate-200 leading-relaxed overflow-x-auto custom-scrollbar select-text bg-slate-950/50 min-h-[260px] prose prose-invert max-w-none"
                                dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(entry.htmlBody) }}
                              />
                            ) : (
                              <pre className="p-6 text-sm text-slate-200 leading-relaxed whitespace-pre-wrap font-sans select-text bg-slate-950/50 min-h-[260px]">
                                {entry.rawBodyText || '(空文本)'}
                              </pre>
                            )}
                          </div>
                        )
                      )}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="text-center text-slate-500 py-10">无大模型解析结果</div>
            )}
          </div>
      </>
    );
  }

  if (editingEntryIndex !== null) {
    const entry = history[editingEntryIndex];
    if (!entry) return null;
    const editingNotionStatus = entry.aiResult?.notionSync?.status || (entry.syncedToNotion ? 'success' : 'idle');
    const editingNotionStatusLabel = getNotionSyncStatusLabel(entry.aiResult?.notionSync) || (entry.syncedToNotion ? '已同步' : undefined);
    const editingNotionStatusClass = editingNotionStatus === 'success'
      ? 'bg-green-500/15 text-green-300 border-green-500/30'
      : editingNotionStatus === 'needs_verification'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : editingNotionStatus === 'partial_failed'
          ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
          : 'bg-red-500/15 text-red-300 border-red-500/30';
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 sm:p-8">
        <div className={`glass-panel flex flex-col gap-4 shadow-2xl relative animate-in slide-in-from-right-4 duration-200 ${isWindowMode ? 'w-full max-w-5xl p-8 h-[90vh] rounded-2xl' : 'w-[95%] max-w-[920px] p-6 h-[85vh] rounded-xl'}`}>
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 pb-3 shrink-0">
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              <button
                onClick={() => {
                  setEditingEntryIndex(null);
                  setActiveTab('todos');
                  setPreviewDrawerOpen(false);
                  setSelectedText('');
                  setSelectionSource('');
                  setExpandedThreads({});
                  setLightboxImg(null);
                  setEmailViewMode('light');
                }}
                className="hover:bg-white/10 p-1.5 rounded transition-colors mr-1"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <span className="truncate max-w-[480px]" title={entry.subject}>处理待办 - {entry.subject || '(无主题)'}</span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleReviewed(editingEntryIndex!)}
                className={`h-6 px-2.5 py-0.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all border shrink-0 ${
                  entry.reviewed
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25 shadow-sm shadow-emerald-500/10'
                    : 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25'
                }`}
                title={entry.reviewed ? '点击解除审核标记' : '点击标记为已审核'}
              >
                {entry.reviewed ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <Clock className="w-3.5 h-3.5 shrink-0" />}
                {entry.reviewed ? '已审核' : '未审核'}
              </button>
              {editingNotionStatusLabel && (
                <div className={`h-6 px-2.5 py-0.5 rounded-md text-xs font-medium flex items-center gap-1.5 border shrink-0 ${editingNotionStatusClass}`}>
                  {editingNotionStatus === 'success' ? <UploadCloud className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                  <span>{editingNotionStatusLabel}</span>
                </div>
              )}
            </div>
          </div>

          {renderEmailDetailsContent(entry, editingEntryIndex)}
        </div>
      </div>
    );
  }

  return (
    <div className={`absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm ${isWindowMode ? 'p-0 pt-12' : 'p-4'}`}>
      <div className={`glass-panel flex flex-col gap-4 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 ${isWindowMode ? 'w-full h-full max-w-none rounded-none border-0 p-8' : 'w-[95%] max-w-[940px] p-6 h-[85vh] rounded-xl'}`}>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-3 shrink-0">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Mail className="w-5 h-5 text-pink-400" />
            邮箱监听历史
          </h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setInReviewMode(true);
                setReviewIndex(0);
              }}
              disabled={history.length === 0}
              className="text-xs flex items-center gap-1.5 bg-gradient-to-r from-purple-500/20 to-pink-500/20 hover:from-purple-500/30 hover:to-pink-500/30 text-pink-300 border border-pink-500/30 px-3 py-1.5 rounded-lg transition-all shadow-sm disabled:opacity-50 font-medium"
            >
              <Rocket className="w-3.5 h-3.5 text-pink-400" /> 逐条审核模式 🚀
            </button>

            <button onClick={clearAllHistory} className="text-xs flex items-center gap-1 text-slate-400 hover:text-red-400 transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> 清空
            </button>
            <button
              onClick={handleForceRun}
              disabled={running}
              className="text-xs flex items-center gap-1 bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} /> {running ? '执行中...' : '立即执行扫描'}
            </button>
            {hideStatusBar && (running || scanLogs.length > 0 || progressMsg) && (
              <button
                onClick={() => setHideStatusBar(false)}
                className="text-xs flex items-center gap-1.5 bg-gradient-to-r from-blue-500/20 to-indigo-500/20 hover:from-blue-500/30 hover:to-indigo-500/30 text-blue-300 border border-blue-500/30 px-3 py-1.5 rounded-lg transition-all shadow-sm font-medium animate-pulse"
                title="呼出扫描控制与日志面板"
              >
                <Terminal className="w-3.5 h-3.5 text-blue-400" /> 扫描状态 ({scanLogs.length})
              </button>
            )}
            <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-md transition-colors text-slate-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Integrated Scan Control & Status Bar */}
        {!hideStatusBar && (running || scanLogs.length > 0 || progressMsg) && (
          <div className="bg-slate-900/90 border border-pink-500/30 rounded-xl p-3 shadow-lg shrink-0 animate-in fade-in slide-in-from-top-2 duration-200 flex flex-col gap-2.5">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2 shrink-0">
                {running ? (
                  isStopping ? (
                    <span className="text-xs text-amber-300 font-medium flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在停止，等待当前邮件处理完成...
                    </span>
                  ) : (
                    <>
                      <button
                        onClick={() => setPaused(!paused)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all shadow-sm ${
                          paused
                            ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-blue-500/20 animate-pulse'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30'
                        }`}
                      >
                        {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        {paused ? '继续扫描' : '暂停扫描'}
                      </button>

                      <button
                        onClick={() => { requestStop(); cancelActiveEmailScan(); }}
                        className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 text-xs font-medium flex items-center gap-1.5 transition-all shadow-sm"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" /> 停止扫描
                      </button>
                    </>
                  )
                ) : (
                  <span className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> 扫描队列就绪
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 flex-1 min-w-0 justify-end w-full sm:w-auto bg-black/30 px-3 py-1.5 rounded-lg border border-white/5">
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  isStopping ? 'bg-amber-400 animate-ping' : running ? (paused ? 'bg-amber-400 animate-ping' : 'bg-blue-400 animate-pulse') : 'bg-slate-600'
                }`} />

                <span
                  className="flex-1 min-w-0 font-mono text-xs text-slate-300 truncate text-left sm:text-right cursor-help"
                  title={scanStatusText}
                >
                  {scanStatusText}
                </span>

                {scanLogs.length > 0 && (
                  <button
                    onClick={() => setShowMiniLog(!showMiniLog)}
                    className="text-xs text-pink-300 hover:text-pink-200 flex items-center gap-1 bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded transition-colors shrink-0 font-sans ml-1"
                  >
                    <ScrollText className="w-3 h-3" />
                    {showMiniLog ? '收起日志' : `明细 (${scanLogs.length})`}
                    {showMiniLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                )}
                <button
                  onClick={() => setHideStatusBar(true)}
                  className="text-xs text-slate-400 hover:text-white p-1 hover:bg-white/10 rounded transition-colors ml-1"
                  title="收起此状态日志板，可于顶部导航栏重新呼出"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {showMiniLog && scanLogs.length > 0 && (
              <div className="w-full max-h-32 bg-black/80 rounded-lg p-2.5 overflow-y-auto text-xs font-mono text-slate-400 border border-white/10 custom-scrollbar space-y-1 mt-1">
                <div className="text-[10px] text-slate-500 border-b border-white/5 pb-1 mb-1 flex justify-between items-center">
                  <span>后台执行步骤明细日志 (最近 100 条)</span>
                  <button
                    onClick={() => useScannerStore.getState().clearScanLogs()}
                    className="hover:text-red-400 transition-colors"
                  >
                    清空日志
                  </button>
                </div>
                {scanLogs.map((log, idx) => (
                  <div key={idx} className="whitespace-pre-wrap break-words hover:text-slate-200 transition-colors" title={log}>
                    {log}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden flex border-t border-white/5">
          {loading ? (
            <div className="w-full text-center text-slate-500 py-10">加载中...</div>
          ) : history.length === 0 ? (
            <div className="w-full text-center text-slate-500 py-10">暂无执行记录</div>
          ) : (
            <>
              {/* Sidebar */}
              <div className="w-56 flex-shrink-0 border-r border-white/5 overflow-y-auto custom-scrollbar bg-black/20">
                {folders.map(folder => (
                  <div key={folder} className="mb-2">
                    <div className="px-4 py-2 text-xs font-medium text-slate-500 bg-slate-900/50 sticky top-0 backdrop-blur z-10 border-b border-white/5">
                      {folder}
                    </div>
                    <div className="py-1">
                      {Object.keys(grouped[folder]).sort((a, b) => b.localeCompare(a)).map(dateStr => {
                        const isSelected = selectedGroup?.folder === folder && selectedGroup?.date === dateStr;
                        return (
                          <button
                            key={dateStr}
                            onClick={() => setSelectedGroup({ folder, date: dateStr })}
                            className={`w-full text-left px-5 py-2 text-sm transition-all ${
                              isSelected
                                ? 'bg-pink-500/10 text-pink-300 border-r-2 border-pink-500 font-medium'
                                : 'text-slate-400 hover:bg-white/5 hover:text-slate-300'
                            }`}
                          >
                            {dateStr}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Main Content */}
              <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-black/10">
                {selectedGroup && grouped[selectedGroup.folder] && grouped[selectedGroup.folder][selectedGroup.date] && (
                  <div className="space-y-4">
                    {grouped[selectedGroup.folder][selectedGroup.date].map((entry) => {
                      const idx = entry.originalIndex;
                      const todosCount = entry.aiResult?.todos?.length || 0;
                      const listNotionStatus = entry.aiResult?.notionSync?.status || (entry.syncedToNotion ? 'success' : 'idle');
                      const listNotionStatusLabel = getNotionSyncStatusLabel(entry.aiResult?.notionSync) || (entry.syncedToNotion ? '已同步' : undefined);
                      const listNotionStatusClass = listNotionStatus === 'success'
                        ? 'bg-green-500/15 text-green-300 border-green-500/30'
                        : listNotionStatus === 'needs_verification'
                          ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                          : listNotionStatus === 'partial_failed'
                            ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
                            : 'bg-red-500/15 text-red-300 border-red-500/30';
                      const isListExpanded = !!expandedTodos[`list_${idx}`];
                      const displayTodos = isListExpanded ? (entry.aiResult?.todos || []) : (entry.aiResult?.todos || []).slice(0, 3);

                      return (
                        <div
                          key={idx}
                          onDoubleClick={() => {
                            if (entry.status === 'success' && entry.aiResult) {
                              setEditingEntryIndex(idx);
                              setActiveTab('todos');
                              setPreviewDrawerOpen(false);
                              setSelectedText('');
                              setLightboxImg(null);
                              setEmailViewMode('light');
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
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleReviewed(idx);
                                }}
                                className={`h-6 px-2.5 py-0.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all border shrink-0 ${
                                  entry.reviewed
                                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25 shadow-sm shadow-emerald-500/10'
                                    : 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25'
                                }`}
                                title={entry.reviewed ? '已审核 (点击人工解除)' : '未审核 (点击标记为已审核)'}
                              >
                                {entry.reviewed ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <Clock className="w-3.5 h-3.5 shrink-0" />}
                                {entry.reviewed ? '已审核' : '未审核'}
                              </button>
                              <FeedbackStatusBadge
                                feedbackStatus={entry.aiResult?.feedbackStatus}
                                feedbackType={entry.aiResult?.feedbackType}
                                explicitFeedback={entry.aiResult?.explicitFeedback}
                                isRejected={entry.aiResult?.isRejected}
                              />
                              {listNotionStatusLabel && (
                                <div className={`h-6 px-2.5 py-0.5 rounded-md text-xs font-medium flex items-center gap-1.5 border shrink-0 ${listNotionStatusClass}`}>
                                  {listNotionStatus === 'success' ? <UploadCloud className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                                  <span>{listNotionStatusLabel}</span>
                                  {entry.aiResult?.notionSync && entry.aiResult.notionSync.failedCount > 0 && ` · ${entry.aiResult.notionSync.failedCount} 项`}
                                </div>
                              )}
                              <div className="h-6 px-2 py-0.5 rounded-md text-xs text-slate-400 font-mono bg-slate-800/80 border border-slate-700/50 flex items-center gap-1 shrink-0">
                                UID: {entry.emailUid}
                              </div>
                              <button onClick={(e) => removeHistoryItem(idx, e)} className="p-1 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded-md transition-all text-slate-400 hover:text-red-400">
                                <Trash2 className="w-4 h-4" />
                              </button>
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
                              <p className="text-sm text-slate-300 mb-2 line-clamp-2">{entry.aiResult.summary}</p>
                              {todosCount > 0 ? (
                                <div className="space-y-2 mt-3">
                                  {displayTodos.map((todo, tIdx) => {
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

                                  {todosCount > 3 && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleExpand(`list_${idx}`);
                                      }}
                                      className="w-full py-1.5 mt-2 text-xs text-slate-400 hover:text-slate-300 hover:bg-white/5 rounded border border-dashed border-white/10 transition-colors"
                                    >
                                      {isListExpanded ? '收起多余待办' : `展开剩余 ${todosCount - 3} 项待办...`}
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs text-slate-500 mt-2">未提取到待办事项</p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {confirmDialog.isOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}>
          <div className="bg-slate-900 border border-white/10 rounded-xl p-6 max-w-sm w-full shadow-2xl flex flex-col gap-4 animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white">
              {confirmDialog.isAlert ? "提示" : "确认操作"}
            </h3>
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{confirmDialog.message}</p>
            <div className="flex justify-end gap-3 mt-2">
              {!confirmDialog.isAlert && (
                <button
                  onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                  className="px-4 py-2 text-sm text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 rounded-md transition-colors"
                >
                  取消
                </button>
              )}
              {confirmDialog.onSecondary && (
                <button
                  onClick={() => void confirmDialog.onSecondary?.()}
                  className="px-4 py-2 text-sm text-amber-200 hover:text-white bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 rounded-md transition-colors"
                >
                  {confirmDialog.secondaryLabel || '其他操作'}
                </button>
              )}
              <button
                onClick={() => void confirmDialog.onConfirm()}
                className={`px-4 py-2 text-sm text-white rounded-md shadow-lg transition-all active:scale-95 ${confirmDialog.isAlert ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/20' : 'bg-pink-600 hover:bg-pink-500 shadow-pink-500/20'}`}
              >
                {confirmDialog.confirmLabel || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200 cursor-zoom-out"
          onClick={() => setLightboxImg(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center">
            <button
              onClick={() => setLightboxImg(null)}
              className="absolute -top-10 right-0 p-2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            <img src={lightboxImg} alt="全屏大图" className="max-w-full max-h-[85vh] object-contain rounded shadow-2xl border border-white/20" />
            <span className="text-xs text-slate-400 mt-2">点击任意位置退出高清大图预览</span>
          </div>
        </div>
      )}
    </div>
  )
}

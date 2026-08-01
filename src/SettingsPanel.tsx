import { useEffect, useState } from 'react'
import { X, Save, Key, Database, BrainCircuit, Wand2, Terminal, Loader2, CheckCircle2, XCircle, RotateCcw, Settings, Sparkles, Undo2, Keyboard, ArrowUp, ArrowDown, Mail, Plus, Trash2, ShieldCheck, ChevronDown, ChevronUp, Lock, Maximize2 } from 'lucide-react'
import { useSettingsStore, getSortedLLMProviders, type LLMProvider } from './store'
import { logger } from './lib/logger'
import { fetchWithTimeout } from './lib/http'
import { notionDatabaseEndpoint, notionHeaders } from './lib/notionApi'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ZenEditorModal } from './components/ZenEditorModal'


import { decodeIMAPFolder } from './lib/imapFolder'
interface SettingsPanelProps {

  onClose: () => void;
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const {
    apiBaseUrl, apiKey, modelName, personalFocus, notionApiKey, notionDatabaseId, enableLogging, globalShortcut,
    notionProperties, fieldMappings, tokenLimit, enableReasoning, emailConfig, enableFailover, failoverRetryCount, isWindowMode,
    promptMode, staticPersonalFocus, autoOptimizedFocus, staticFocusUpdatedAt, autoOptimizedUpdatedAt,
    setPromptMode, setStaticFocus, setAutoOptimizedFocus, setNotionSettings, setEnableLogging, setGlobalShortcut, setNotionProperties, setFieldMapping, setTokenLimit, setEnableReasoning, setEmailConfig, setLLMProviders, setFailoverConfig, setWindowMode
  } = useSettingsStore();

  const [formProviders, setFormProviders] = useState<LLMProvider[]>(() => {
    const list = getSortedLLMProviders();
    if (list.length === 0) {
      return [{
        id: 'default-' + Date.now(),
        name: '默认服务商',
        apiBaseUrl: apiBaseUrl || 'https://api.openai.com/v1',
        apiKey: apiKey || '',
        modelName: modelName || 'gpt-4o',
        enabled: true,
        priority: 1
      }];
    }
    return list;
  });
  const [formEnableFailover, setFormEnableFailover] = useState<boolean>(enableFailover !== undefined ? enableFailover : true);
  const [formRetryCount, setFormRetryCount] = useState<number>(failoverRetryCount || 1);
  const [showFailoverGuide, setShowFailoverGuide] = useState<boolean>(false);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<Record<string, { status: 'success' | 'error', msg?: string }>>({});
  
  const [formPromptMode, setFormPromptMode] = useState<'static' | 'auto'>(promptMode);
  const [formStaticFocus, setFormStaticFocus] = useState(staticPersonalFocus || personalFocus);
  const [formAutoFocus, setFormAutoFocus] = useState(autoOptimizedFocus);
  const [isFocusEditorOpen, setIsFocusEditorOpen] = useState(false);
  const [formNotionKey, setFormNotionKey] = useState(notionApiKey);
  const [formNotionDb, setFormNotionDb] = useState(notionDatabaseId);
  const [formLogging, setFormLogging] = useState(enableLogging);
  const [formGlobalShortcut, setFormGlobalShortcut] = useState(globalShortcut);
  const [formWindowMode, setFormWindowMode] = useState(isWindowMode);
  const [formTokenLimit, setFormTokenLimit] = useState(tokenLimit);
  const [formEnableReasoning, setFormEnableReasoning] = useState(enableReasoning);
  const [formEmailConfig, setFormEmailConfig] = useState(emailConfig);
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [folderError, setFolderError] = useState('');

  const handleFetchFolders = async () => {
    if (!formEmailConfig.host || !formEmailConfig.user || !formEmailConfig.pass) {
      setFolderError('请先填写 IMAP 服务器和账号密码');
      return;
    }
    setLoadingFolders(true);
    setFolderError('');
    try {
      const folders = await invoke<string[]>('get_email_folders', {
        host: formEmailConfig.host.trim(),
        port: formEmailConfig.port,
        user: formEmailConfig.user.trim(),
        pass: formEmailConfig.pass.trim(),
        ssl: formEmailConfig.ssl
      });
      setAvailableFolders(folders);
    } catch (e: any) {
      setFolderError('获取文件夹失败: ' + String(e));
    } finally {
      setLoadingFolders(false);
    }
  };

  const [formFieldMappings, setFormFieldMappings] = useState(fieldMappings);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [liveShortcut, setLiveShortcut] = useState('');
  const [activeTab, setActiveTab] = useState<'ai' | 'integration' | 'email' | 'system'>('ai');

  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [analyzingHistory, setAnalyzingHistory] = useState(false);
  const [previousFocus, setPreviousFocus] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    message: string;
    isAlert?: boolean;
    onConfirm: () => void;
  }>({ isOpen: false, message: '', onConfirm: () => {} });

  const showAlert = (message: string) => {
    setConfirmDialog({
      isOpen: true,
      message,
      isAlert: true,
      onConfirm: () => setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    });
  };

  const [testingNotion, setTestingNotion] = useState(false);
  const [notionTestResult, setNotionTestResult] = useState<'none' | 'success' | 'error'>('none');
  const [notionTestErrorMsg, setNotionTestErrorMsg] = useState('');
  const [copiedFocus, setCopiedFocus] = useState(false);

  const handleSave = () => {
    setLLMProviders(formProviders);
    setFailoverConfig(formEnableFailover, formRetryCount);
    setPromptMode(formPromptMode);
    setStaticFocus(formStaticFocus);
    setAutoOptimizedFocus(formAutoFocus);
    setNotionSettings(formNotionKey, formNotionDb);
    setEnableLogging(formLogging);
    setGlobalShortcut(formGlobalShortcut);
    setTokenLimit(formTokenLimit);
    setEnableReasoning(formEnableReasoning);
    setEmailConfig(formEmailConfig);
    Object.entries(formFieldMappings).forEach(([k, v]) => setFieldMapping(k, v));
    setWindowMode(formWindowMode);

    const win = getCurrentWindow();
    if (formWindowMode) {
      win.setSkipTaskbar(false).catch(console.error);
      win.setAlwaysOnTop(false).catch(console.error);
      win.setResizable(true).catch(console.error);
    } else {
      win.setSkipTaskbar(true).catch(console.error);
      win.setAlwaysOnTop(true).catch(console.error);
      win.setResizable(false).catch(console.error);
    }
    
    // 同步到后端 Rust
    import('@tauri-apps/api/core').then(m => {
        m.invoke('update_shortcut', { shortcut: formGlobalShortcut }).catch(e => {
            console.error('Update shortcut failed', e);
            showAlert(`快捷键应用失败: ${e}\n可能该快捷键不合法或被系统占用。`);
        });
    });

    logger.info('Settings saved.');
    onClose();
  };

  useEffect(() => {
    let disposed = false

    const syncShortcutRecordingState = async () => {
      try {
        const api = await import('@tauri-apps/api/core')
        if (disposed) return

        await api.invoke('set_recording_mode', { isRecording: isRecordingShortcut })
        if (isRecordingShortcut) {
          await api.invoke('unregister_shortcut')
        } else {
          // Editing a shortcut is only a draft operation. Restore the persisted shortcut until the user saves.
          await api.invoke('update_shortcut', { shortcut: globalShortcut })
        }
      } catch (error) {
        console.error('Failed to synchronize shortcut recording state', error)
      }
    }

    void syncShortcutRecordingState()

    const blockSystemMenu = (event: KeyboardEvent) => {
      if (isRecordingShortcut) {
        event.preventDefault()
      }
    }

    if (isRecordingShortcut) {
      window.addEventListener('keydown', blockSystemMenu, { capture: true })
    }

    return () => {
      disposed = true
      window.removeEventListener('keydown', blockSystemMenu, { capture: true })
    }
  }, [isRecordingShortcut, globalShortcut])

  useEffect(() => () => {
    void import('@tauri-apps/api/core').then((api) => api.invoke('set_recording_mode', { isRecording: false })).catch(console.error)
  }, [])

  const buildShortcutString = (e: React.KeyboardEvent) => {
    const parts = [];
    if (e.metaKey) parts.push('Super');
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    return parts;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      setIsRecordingShortcut(false);
      setLiveShortcut('');
      e.currentTarget.blur();
      return;
    }

    const parts = buildShortcutString(e);
    const isModifier = e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta';
    
    if (isModifier) {
      setLiveShortcut(parts.join('+'));
      return;
    }

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    
    parts.push(key);
    setFormGlobalShortcut(parts.join('+'));
    setLiveShortcut('');
    setIsRecordingShortcut(false);
    e.currentTarget.blur();
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (isRecordingShortcut) {
      const parts = buildShortcutString(e);
      setLiveShortcut(parts.join('+'));
    }
  };

  const testProviderConnection = async (provider: LLMProvider) => {
    if (!provider.apiKey || !provider.apiBaseUrl || !provider.modelName) {
      setProviderTestResults(prev => ({ ...prev, [provider.id]: { status: 'error', msg: '请完整填写 URL、Key 和模型名称' } }));
      return;
    }
    setTestingProviderId(provider.id);
    setProviderTestResults(prev => ({ ...prev, [provider.id]: undefined as any }));
    try {
      const isOSeries = /^o\d+/.test(provider.modelName.toLowerCase());
      const isClaude = provider.modelName.toLowerCase().includes('claude');
      const isDeepSeek = provider.modelName.toLowerCase().includes('deepseek') || provider.modelName.toLowerCase().includes('reasoner') || provider.modelName.toLowerCase().includes('thinking');

      const payload: any = {
        model: provider.modelName,
        messages: [{ role: 'user', content: 'Say "OK" if you receive this.' }]
      };
      
      if (isOSeries) {
        payload.max_completion_tokens = 5;
      } else {
        payload.max_tokens = 5;
      }

      if (!formEnableReasoning) {
        if (isOSeries) {
          payload.reasoning_effort = "low";
        } else if (isClaude) {
          payload.thinking = { type: "disabled" };
        } else if (isDeepSeek) {
          payload.reasoning_effort = "low";
        }
      } else {
        if (isOSeries) {
          payload.reasoning_effort = "high";
        } else if (isClaude) {
          payload.thinking = { type: "enabled", budget_tokens: 1024 };
        }
      }

      const normalizedUrl = provider.apiBaseUrl.trim().endsWith('/') ? provider.apiBaseUrl.trim().slice(0, -1) : provider.apiBaseUrl.trim();
      logger.info('Testing provider API connection...', { baseUrl: normalizedUrl, model: provider.modelName });

      const response = await fetchWithTimeout(`${normalizedUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP Error ${response.status}`);
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0) {
        setProviderTestResults(prev => ({ ...prev, [provider.id]: { status: 'success' } }));
        logger.info('Provider API connection test successful', data);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : e.message || JSON.stringify(e);
      setProviderTestResults(prev => ({ ...prev, [provider.id]: { status: 'error', msg: msg.slice(0, 100) } }));
      logger.error('Provider API connection test failed', msg);
    } finally {
      setTestingProviderId(null);
    }
  };

  const handleTestNotion = async () => {
    if (!formNotionKey || !formNotionDb) {
      setNotionTestResult('error');
      setNotionTestErrorMsg('请填写 API Key 和 Database ID');
      return;
    }
    
    setTestingNotion(true);
    setNotionTestResult('none');
    setNotionTestErrorMsg('');
    
    try {
      logger.info('Testing Notion connection...');
      const response = await fetchWithTimeout(notionDatabaseEndpoint(formNotionDb), {
        method: 'GET',
        headers: notionHeaders(formNotionKey),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || `HTTP Error ${response.status}`);
      }

      const data = await response.json();
      
      const props: any[] = [];
      if (data.properties) {
        for (const val of Object.values<any>(data.properties)) {
          let options = undefined;
          if (val.type === 'select' && val.select?.options) {
            options = val.select.options.map((o: any) => o.name);
          } else if (val.type === 'status' && val.status?.options) {
            options = val.status.options.map((o: any) => o.name);
          } else if (val.type === 'multi_select' && val.multi_select?.options) {
            options = val.multi_select.options.map((o: any) => o.name);
          }
          props.push({
            id: val.id,
            name: val.name,
            type: val.type,
            options
          });
        }
      }
      // Sort to put title first
      props.sort((a, b) => a.type === 'title' ? -1 : b.type === 'title' ? 1 : 0);
      setNotionProperties(props);
      
      const newMappings = { ...formFieldMappings };
      props.forEach((p, idx) => {
        if (!newMappings[p.id]) {
          newMappings[p.id] = { notionPropId: p.id, enabled: p.type === 'title', aiHint: '', order: idx };
        } else if (newMappings[p.id].order === undefined) {
          newMappings[p.id].order = idx;
        }
      });
      setFormFieldMappings(newMappings);

      setNotionTestResult('success');
      logger.info('Notion connection test successful and schema loaded', { fieldsCount: props.length });
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setNotionTestResult('error');
      setNotionTestErrorMsg(msg);
      logger.error('Notion connection test failed', msg);
    } finally {
      setTestingNotion(false);
    }
  };

  const handleOptimizePrompt = async () => {
    const topProvider = formProviders.find(p => p.enabled) || formProviders[0];
    if (!topProvider || !topProvider.apiBaseUrl || !topProvider.apiKey || !topProvider.modelName) {
      showAlert("请先在上方配置至少一个有效的大模型服务商及 API Key！");
      return;
    }
    if (!formStaticFocus.trim() && formPromptMode === 'static') {
      showAlert("请先输入简单的关注方向描述，AI 才能帮您润色。");
      return;
    }

    setOptimizingPrompt(true);
    try {
      const normalizedUrl = topProvider.apiBaseUrl.trim().endsWith('/') ? topProvider.apiBaseUrl.trim().slice(0, -1) : topProvider.apiBaseUrl.trim();
      const isOSeries = /^o\d+/.test(topProvider.modelName.toLowerCase());
      const isClaude = topProvider.modelName.toLowerCase().includes('claude');
      const isDeepSeek = topProvider.modelName.toLowerCase().includes('deepseek') || topProvider.modelName.toLowerCase().includes('reasoner') || topProvider.modelName.toLowerCase().includes('thinking');

      const messages: any[] = [{
        role: 'system',
        content: '你是一个资深的 Prompt Engineer。请将用户输入的一段简单的任务关注点描述，润色为一段结构清晰、语气专业且指令明确的「系统提示词（System Prompt）」，用于指导另一个大模型精准提取相关待办事项。\n\n【项目背景要求】\n你的润色结果将被注入到本系统的主 Prompt 中。主 Prompt 已经强制要求模型以 JSON 格式输出待办事项，且只包含 `title`(标题), `priority`(优先级), `planned_date`(计划日期) 字段。因此，你的润色内容应专注于**提取规则、业务逻辑、内容过滤标准、优先级评判倾向**等，**绝对不要**包含关于输出格式（如 JSON、Markdown、字段定义）的指令。\n\n【关键约束】\n1. 表达必须清晰、明确、严谨。\n2. 绝对不可额外捏造或增添用户未说明的背景、领域知识或未提及的业务要求。\n3. 仅做形式上的专业化改写，直接输出润色后的提示词，绝不要包含任何开场白或解释。'
      }];

      if (!formEnableReasoning) {
        messages.push({
          role: 'user',
          content: `${formPromptMode === 'static' ? formStaticFocus : formAutoFocus}\n\n(指令：请直接输出最终结果，跳过所有思维链、推导过程和思考步骤。)\n/no_think`
        });
      } else {
        messages.push({ role: 'user', content: formPromptMode === 'static' ? formStaticFocus : formAutoFocus });
      }

      const payload: any = {
        model: topProvider.modelName,
        messages
      };

      if (!formEnableReasoning) {
        if (isOSeries) {
          payload.reasoning_effort = "low";
        } else if (isClaude) {
          payload.thinking = { type: "disabled" };
        } else if (isDeepSeek) {
          payload.reasoning_effort = "low";
        }
      } else {
        if (isOSeries) {
          payload.reasoning_effort = "high";
        } else if (isClaude) {
          payload.thinking = { type: "enabled", budget_tokens: 2048 };
        }
      }

      const response = await fetchWithTimeout(`${normalizedUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${topProvider.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}`);
      }

      const data = await response.json();
      logger.info('Received raw prompt optimization response from AI', { response: data });
      if (data.choices && data.choices.length > 0) {
        if (formPromptMode === 'static') {
          setPreviousFocus(formStaticFocus);
          setFormStaticFocus(data.choices[0].message.content.trim());
        } else {
          setPreviousFocus(formAutoFocus);
          setFormAutoFocus(data.choices[0].message.content.trim());
        }
        logger.info('Prompt optimization successful');
      }
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      logger.error('Prompt optimization failed', msg);
      showAlert(`润色失败: ${msg}`);
    } finally {
      setOptimizingPrompt(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 sm:p-8">
      <div className={`glass-panel flex flex-col min-h-[60vh] shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 ${isWindowMode ? 'w-full max-w-5xl p-8 max-h-[90vh] rounded-2xl' : 'w-full max-w-[820px] p-6 max-h-[90vh] rounded-xl'}`}>
        <div className={`flex flex-col flex-1 min-h-0 mx-auto w-full overflow-hidden ${isWindowMode ? 'max-w-6xl' : ''}`}>
        
        {/* Header */}
        <div className="flex-none flex items-center justify-between border-b border-white/10 pb-3 mb-2">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Settings className="w-5 h-5 text-purple-400" />
            全局设置
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-md transition-colors text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex-none flex items-center gap-6 border-b border-white/5 mb-4">
          <button
            onClick={() => setActiveTab('ai')}
            className={`pb-3 text-sm font-medium transition-colors relative ${activeTab === 'ai' ? 'text-purple-400' : 'text-slate-400 hover:text-slate-300'}`}
          >
            <div className="flex items-center gap-2"><BrainCircuit className="w-4 h-4" /> AI 与偏好</div>
            {activeTab === 'ai' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500 rounded-t-full shadow-[0_0_8px_rgba(168,85,247,0.5)]"></div>}
          </button>
          <button
            onClick={() => setActiveTab('integration')}
            className={`pb-3 text-sm font-medium transition-colors relative ${activeTab === 'integration' ? 'text-orange-400' : 'text-slate-400 hover:text-slate-300'}`}
          >
            <div className="flex items-center gap-2"><Database className="w-4 h-4" /> 集成与推送</div>
            {activeTab === 'integration' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-500 rounded-t-full shadow-[0_0_8px_rgba(249,115,22,0.5)]"></div>}
          </button>
          <button
            onClick={() => setActiveTab('email')}
            className={`pb-3 text-sm font-medium transition-colors relative ${activeTab === 'email' ? 'text-pink-400' : 'text-slate-400 hover:text-slate-300'}`}
          >
            <div className="flex items-center gap-2"><Mail className="w-4 h-4" /> 邮件监听</div>
            {activeTab === 'email' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-pink-500 rounded-t-full shadow-[0_0_8px_rgba(244,114,182,0.5)]"></div>}
          </button>
          <button
            onClick={() => setActiveTab('system')}
            className={`pb-3 text-sm font-medium transition-colors relative ${activeTab === 'system' ? 'text-teal-400' : 'text-slate-400 hover:text-slate-300'}`}
          >
            <div className="flex items-center gap-2"><Settings className="w-4 h-4" /> 系统配置</div>
            {activeTab === 'system' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-teal-500 rounded-t-full shadow-[0_0_8px_rgba(20,184,166,0.5)]"></div>}
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col gap-5 flex-1 min-h-0 overflow-y-auto pr-2 custom-scrollbar relative">
          
          {/* --- TAB: AI & Focus --- */}
          <div className={`space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 ${activeTab !== 'ai' ? 'hidden' : ''}`}>
            {/* AI Failover Guide Banner */}
            <div className="bg-gradient-to-r from-purple-500/10 via-pink-500/10 to-blue-500/10 border border-purple-500/20 rounded-xl p-4 shadow-md transition-all">
              <div 
                className="flex items-center justify-between cursor-pointer select-none"
                onClick={() => setShowFailoverGuide(!showFailoverGuide)}
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-purple-400" />
                  <h4 className="text-xs font-semibold text-purple-200 tracking-wide">
                    多大模型智能调度与故障转移指南 (AI Failover Guide)
                  </h4>
                </div>
                <div className="flex items-center gap-2 text-xs text-purple-400 hover:text-purple-300">
                  <span>{showFailoverGuide ? '收起指南' : '了解工作原理'}</span>
                  {showFailoverGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </div>
              </div>

              {showFailoverGuide && (
                <div className="mt-3 pt-3 border-t border-white/10 text-xs text-slate-300 space-y-2 leading-relaxed font-sans">
                  <p className="flex items-start gap-2">
                    <span className="text-purple-400 font-bold shrink-0">1. 触发时机：</span>
                    <span>当网络超时、API 速率限制 (429) 或服务端异常 (5xx) 达到单节点重试上限时，系统自动顺位降级轮换至下一可用服务商。</span>
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="text-pink-400 font-bold shrink-0">2. 优先级排序：</span>
                    <span>通过列表右侧的 <ArrowUp className="w-3 h-3 inline text-slate-400" /> <ArrowDown className="w-3 h-3 inline text-slate-400" /> 按钮调整顺序。排在最上方的已启用服务商拥有第一优先级。</span>
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="text-blue-400 font-bold shrink-0">3. 零额外消耗：</span>
                    <span>故障转移为本地逻辑控制，未调通的请求不会产生额外 Token 扣费或无效调用。</span>
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="text-emerald-400 font-bold shrink-0">4. 安全无忧：</span>
                    <span>您的所有 API Key 均采用 Rust 强加密算法在本地持久化存储，保护核心敏感隐私。</span>
                  </p>
                </div>
              )}
            </div>

            {/* Multi-LLM Provider Settings */}
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-purple-300 flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4" /> 多供应商模型管理
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    按优先级排列多个模型，当第一顺位服务不可用时将自动平滑轮换
                  </p>
                </div>

                <button
                  onClick={() => {
                    const newProvider: LLMProvider = {
                      id: 'provider-' + Date.now(),
                      name: '新模型服务商',
                      apiBaseUrl: 'https://api.openai.com/v1',
                      apiKey: '',
                      modelName: 'gpt-4o',
                      enabled: true,
                      priority: formProviders.length + 1
                    };
                    setFormProviders([...formProviders, newProvider]);
                  }}
                  className="text-xs flex items-center gap-1.5 bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 text-white font-medium px-3 py-1.5 rounded-lg shadow-sm transition self-start sm:self-auto"
                >
                  <Plus className="w-3.5 h-3.5" /> 添加服务商
                </button>
              </div>

              {/* Provider List (Card/Table view) */}
              <div className="space-y-3">
                {formProviders.map((provider, index) => {
                  const testRes = providerTestResults[provider.id];
                  return (
                    <div 
                      key={provider.id} 
                      className={`p-4 rounded-xl border transition-all ${
                        provider.enabled 
                          ? 'bg-slate-900/70 border-white/15 shadow-md' 
                          : 'bg-slate-950/40 border-white/5 opacity-60'
                      }`}
                    >
                      <div className="flex flex-col gap-3 mb-3 pb-3 border-b border-white/5">
                        {/* Row 1: Name, Badge, Enable Switch, Delete */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 flex-1 min-w-0">
                            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold font-mono shrink-0 ${
                              index === 0 && provider.enabled
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                                : 'bg-white/5 text-slate-400'
                            }`}>
                              #{index + 1}
                            </span>
                            
                            <input
                              type="text"
                              value={provider.name}
                              onChange={(e) => {
                                const updated = [...formProviders];
                                updated[index] = { ...provider, name: e.target.value };
                                setFormProviders(updated);
                              }}
                              className="bg-transparent border border-transparent hover:border-white/10 focus:border-purple-500 rounded px-2 py-1 text-sm font-semibold text-white focus:bg-slate-800 outline-none flex-1 max-w-[200px] min-w-[120px] transition truncate"
                              placeholder="服务商名称 (如 OpenAI)"
                            />

                            {index === 0 && provider.enabled && (
                              <span className="text-[10px] bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full border border-purple-500/30 shrink-0 font-medium">
                                首选主力
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <label className="flex items-center cursor-pointer select-none bg-black/40 px-2.5 py-1 rounded-md border border-white/5">
                              <input
                                type="checkbox"
                                checked={provider.enabled}
                                onChange={(e) => {
                                  const updated = [...formProviders];
                                  updated[index] = { ...provider, enabled: e.target.checked };
                                  setFormProviders(updated);
                                }}
                                className="rounded border-slate-600 bg-slate-800 text-purple-500 focus:ring-0 w-3.5 h-3.5 mr-1.5"
                              />
                              <span className="text-xs text-slate-300">{provider.enabled ? '启用' : '停用'}</span>
                            </label>

                            <button
                              onClick={() => {
                                if (formProviders.length <= 1) {
                                  showAlert("至少需要保留一个大模型服务商");
                                  return;
                                }
                                const updated = formProviders.filter((_, i) => i !== index);
                                setFormProviders(updated.map((p, i) => ({ ...p, priority: i + 1 })));
                              }}
                              className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-md transition"
                              title="删除此服务商"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Row 2: Test API & Priority Move Controls */}
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <button
                            onClick={() => testProviderConnection(provider)}
                            disabled={testingProviderId === provider.id || !provider.enabled}
                            className="text-xs bg-white/5 hover:bg-white/10 text-slate-300 px-3 py-1.5 rounded-md transition flex items-center gap-1.5 disabled:opacity-40 font-medium border border-white/5"
                            title="测试此服务商 API 连通性"
                          >
                            {testingProviderId === provider.id ? <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-400" /> : <Sparkles className="w-3.5 h-3.5 text-purple-400" />}
                            测试连通性
                          </button>

                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-slate-500 mr-1 hidden sm:inline">优先级调换:</span>
                            <div className="flex items-center bg-black/40 rounded-md p-0.5 border border-white/5">
                              <button
                                onClick={() => {
                                  if (index <= 0) return;
                                  const updated = [...formProviders];
                                  const tmp = updated[index - 1];
                                  updated[index - 1] = updated[index];
                                  updated[index] = tmp;
                                  setFormProviders(updated.map((p, i) => ({ ...p, priority: i + 1 })));
                                }}
                                disabled={index <= 0}
                                className="px-2 py-1 hover:bg-white/10 text-slate-400 hover:text-white rounded disabled:opacity-20 transition flex items-center gap-1 text-xs"
                                title="上移优先级"
                              >
                                <ArrowUp className="w-3.5 h-3.5" /> 上移
                              </button>
                              <div className="w-[1px] h-3 bg-white/10 mx-0.5" />
                              <button
                                onClick={() => {
                                  if (index >= formProviders.length - 1) return;
                                  const updated = [...formProviders];
                                  const tmp = updated[index + 1];
                                  updated[index + 1] = updated[index];
                                  updated[index] = tmp;
                                  setFormProviders(updated.map((p, i) => ({ ...p, priority: i + 1 })));
                                }}
                                disabled={index >= formProviders.length - 1}
                                className="px-2 py-1 hover:bg-white/10 text-slate-400 hover:text-white rounded disabled:opacity-20 transition flex items-center gap-1 text-xs"
                                title="下移优先级"
                              >
                                下移 <ArrowDown className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Test Result Message */}
                      {testRes && (
                        <div className={`mb-3 p-2 rounded text-xs flex items-center gap-1.5 ${
                          testRes.status === 'success' 
                            ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' 
                            : 'bg-red-500/10 text-red-300 border border-red-500/20'
                        }`}>
                          {testRes.status === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" /> : <XCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />}
                          <span className="truncate">{testRes.status === 'success' ? '测试成功，API 响应正常！' : `连接失败: ${testRes.msg}`}</span>
                        </div>
                      )}

                      {/* Provider Inputs Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                          <label className="text-xs text-slate-400 mb-1 block font-mono">API Base URL</label>
                          <input
                            type="text"
                            data-testid={index === 0 ? 'settings-api-base-url' : undefined}
                            value={provider.apiBaseUrl}
                            onChange={(e) => {
                              const updated = [...formProviders];
                              updated[index] = { ...provider, apiBaseUrl: e.target.value };
                              setFormProviders(updated);
                            }}
                            className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs text-slate-200 focus:ring-1 focus:ring-purple-500 outline-none font-mono"
                            placeholder="https://api.openai.com/v1"
                          />
                        </div>

                        <div>
                          <label className="text-xs text-slate-400 mb-1 block font-mono flex items-center justify-between">
                            <span>API Key</span>
                            <span className="text-[10px] text-emerald-400/80 flex items-center gap-0.5"><Lock className="w-2.5 h-2.5" /> 加密存储</span>
                          </label>
                          <input
                            type="password"
                            data-testid={index === 0 ? 'settings-api-key' : undefined}
                            value={provider.apiKey}
                            onChange={(e) => {
                              const updated = [...formProviders];
                              updated[index] = { ...provider, apiKey: e.target.value };
                              setFormProviders(updated);
                            }}
                            className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs text-slate-200 focus:ring-1 focus:ring-purple-500 outline-none font-mono"
                            placeholder="sk-..."
                          />
                        </div>

                        <div>
                          <label className="text-xs text-slate-400 mb-1 block font-mono">Model Name (如 gpt-4o)</label>
                          <input
                            type="text"
                            value={provider.modelName}
                            onChange={(e) => {
                              const updated = [...formProviders];
                              updated[index] = { ...provider, modelName: e.target.value };
                              setFormProviders(updated);
                            }}
                            className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs text-slate-200 focus:ring-1 focus:ring-purple-500 outline-none font-mono"
                            placeholder="gpt-4o / claude-3-7-sonnet / deepseek-chat"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Global Reasoning & Failover Controls */}
              <div className="bg-slate-900/40 p-4 rounded-xl border border-white/10 space-y-3 mt-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="enableFailover"
                      checked={formEnableFailover}
                      onChange={(e) => setFormEnableFailover(e.target.checked)}
                      className="w-4 h-4 rounded border-white/20 bg-black/20 text-purple-500 focus:ring-purple-500/50 cursor-pointer"
                    />
                    <label htmlFor="enableFailover" className="text-xs font-medium text-slate-200 select-none cursor-pointer flex items-center gap-1.5">
                      <RotateCcw className="w-3.5 h-3.5 text-pink-400" /> 开启异常自动轮换 (Failover Rotation)
                    </label>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>单节点失败最大重试次数：</span>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={formRetryCount}
                      onChange={(e) => setFormRetryCount(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))}
                      className="w-16 bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-center text-white font-mono focus:ring-1 focus:ring-purple-500 outline-none"
                    />
                    <span>次</span>
                  </div>
                </div>

                <div className="border-t border-white/5 pt-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="enableReasoning"
                      checked={formEnableReasoning}
                      onChange={(e) => setFormEnableReasoning(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-white/20 bg-black/20 text-purple-500 focus:ring-purple-500/50 cursor-pointer"
                    />
                    <label htmlFor="enableReasoning" className="text-xs text-slate-300 select-none cursor-pointer">
                      允许大模型进入深度思考与推理模式
                    </label>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    (仅支持 o1, o3-mini, claude-3.7 等具有推理能力的模型)
                  </span>
                </div>
              </div>
            </div>

            <div className="h-px bg-white/5 w-full"></div>

            {/* Personal Focus */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-blue-300 flex items-center gap-2">
                  <Wand2 className="w-4 h-4" /> 个人关注方向与记忆机制
                </h3>
              </div>
              
              <div className="flex items-center gap-4 bg-slate-900/40 p-1.5 rounded-lg border border-white/5 w-fit">
                <button
                  onClick={() => setFormPromptMode('static')}
                  className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${formPromptMode === 'static' ? 'bg-blue-500/20 text-blue-300 shadow-sm border border-blue-500/30' : 'text-slate-400 hover:text-slate-300'}`}
                >
                  静态手动模式
                </button>
                <button
                  onClick={() => setFormPromptMode('auto')}
                  className={`group relative px-4 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${formPromptMode === 'auto' ? 'bg-purple-500/20 text-purple-300 shadow-sm border border-purple-500/30' : 'text-slate-400 hover:text-slate-300'}`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  自动持续演进模式 (推荐)
                  <div className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-white/10 text-[10px] text-white/70 cursor-help">?</div>
                  <div className="absolute hidden group-hover:block w-72 bg-slate-800 text-slate-200 text-xs p-3 rounded-xl border border-white/10 shadow-2xl z-50 -top-2 left-[105%] leading-relaxed">
                    开启后，系统将在您每次修改并同步待办事项到 Notion 后，在后台通过对比您的修改痕迹，自动优化并微调您的个人关注点，让 AI 越用越懂您的特定工作流。
                    <br/><br/>
                    <span className="text-amber-400/90 font-medium">⚠️ 注意：此模式会在每次同步时，在后台额外触发一次轻量级的大模型调用来分析您的修改，这会产生一定的额外 Token 消耗。</span>
                  </div>
                </button>
              </div>

              {formPromptMode === 'static' ? (
                <div className="relative group">
                  <div className="absolute right-2 top-2 flex items-center gap-2 z-10">
                    <button
                      onClick={() => setIsFocusEditorOpen(true)}
                      className="text-xs flex items-center gap-1 bg-indigo-500/80 text-white px-2 py-1 rounded hover:bg-indigo-500 transition shadow-sm backdrop-blur-sm"
                      title="全屏放大沉浸式编辑与保存"
                    >
                      <Maximize2 className="w-3 h-3" />
                      放大编辑
                    </button>
                    {previousFocus !== null && (
                      <button
                        onClick={() => {
                          setFormStaticFocus(previousFocus);
                          setPreviousFocus(null);
                        }}
                        className="text-xs flex items-center gap-1 bg-slate-500/80 text-white px-2 py-1 rounded hover:bg-slate-500 transition shadow-sm backdrop-blur-sm"
                        title="撤销刚才的润色结果，恢复原文本"
                      >
                        <Undo2 className="w-3 h-3" />
                        撤销润色
                      </button>
                    )}
                    <button
                      onClick={handleOptimizePrompt}
                      disabled={optimizingPrompt || !formStaticFocus.trim()}
                      className="text-xs flex items-center gap-1 bg-blue-500/80 text-white px-2 py-1 rounded hover:bg-blue-500 transition disabled:opacity-50 shadow-sm backdrop-blur-sm"
                      title="让 AI 帮您润色和扩充提示词"
                    >
                      {optimizingPrompt ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      智能润色
                    </button>
                  </div>
                  <textarea 
                    value={formStaticFocus} onChange={e => {
                      setFormStaticFocus(e.target.value);
                      if (previousFocus !== null) setPreviousFocus(null);
                    }}
                    className="w-full bg-slate-900/50 border border-white/10 rounded-xl p-3 pt-3 text-sm text-slate-200 min-h-[140px] resize-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all shadow-inner"
                    placeholder="例如：我是一名前端开发，请侧重提取关于 UI、交互、接口联调的待办..."
                  />
                  {staticFocusUpdatedAt > 0 && (
                     <div className="text-[10px] text-slate-500 text-right mt-1 font-mono">最后人工编辑时间: {new Date(staticFocusUpdatedAt).toLocaleString()}</div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="relative group">
                    <div className="absolute right-2 top-2 flex items-center gap-2 z-10">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(formAutoFocus);
                          setCopiedFocus(true);
                          setTimeout(() => setCopiedFocus(false), 2000);
                        }}
                        className="text-xs flex items-center gap-1 bg-slate-700/80 text-white px-2 py-1 rounded hover:bg-slate-600 transition shadow-sm backdrop-blur-sm"
                        title="复制提示词"
                      >
                        {copiedFocus ? '✅ 已复制' : '一键复制'}
                      </button>
                    </div>
                    <textarea 
                      value={formAutoFocus} 
                      readOnly
                      disabled
                      className="w-full bg-slate-950/80 border border-white/5 rounded-xl p-3 text-sm text-slate-400 min-h-[140px] resize-none outline-none shadow-inner cursor-not-allowed"
                      placeholder="系统将在此处自动生成优化后的提示词..."
                    />
                    {autoOptimizedUpdatedAt > 0 && (
                      <div className="text-[10px] text-slate-500 text-right mt-1 font-mono">最后自动优化时间: {new Date(autoOptimizedUpdatedAt).toLocaleString()}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => {
                        setFormStaticFocus(formAutoFocus);
                        setFormPromptMode('static');
                      }}
                      className="text-xs flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg border border-white/5 transition"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      退回静态模式继续编辑
                    </button>

                    <button
                      onClick={() => {
                        setConfirmDialog({
                          isOpen: true,
                          message: "确定要用您当前的「静态手动模式」内容强制覆盖自动演进的最新成果吗？",
                          onConfirm: () => {
                            setFormAutoFocus(formStaticFocus);
                            setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                            // We can use a subtle notification instead of alert if possible, or just nothing since the text will update visibly.
                          }
                        });
                      }}
                      className="text-xs flex items-center gap-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 px-3 py-1.5 rounded-lg border border-amber-500/20 transition"
                    >
                      <Save className="w-3.5 h-3.5" />
                      用静态配置覆盖此内容
                    </button>
                    
                    <button
                      onClick={async () => {
                         setAnalyzingHistory(true);
                         try {
                           const { analyzeHistoryAndUpdateFocus } = await import('./lib/autoOptimize');
                           const newFocus = await analyzeHistoryAndUpdateFocus();
                           setFormAutoFocus(newFocus);
                           showAlert("历史记录分析完毕，您的个人偏好已演进更新！");
                         } catch (e: any) {
                           const msg = typeof e === 'string' ? e : (e.message || JSON.stringify(e));
                           showAlert("历史记录分析失败: " + msg);
                         } finally {
                           setAnalyzingHistory(false);
                         }
                      }}
                      disabled={analyzingHistory}
                      className="text-xs flex items-center gap-1.5 bg-gradient-to-r from-purple-600/80 to-pink-600/80 hover:from-purple-500 hover:to-pink-500 text-white px-3 py-1.5 rounded-lg shadow-md transition disabled:opacity-50"
                    >
                      {analyzingHistory ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                      深度分析历史记录以生成偏好
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* --- TAB: Email --- */}
          <div className={`space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 ${activeTab !== 'email' ? 'hidden' : ''}`}>
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-pink-300 flex items-center gap-2">
                <Mail className="w-4 h-4" /> 邮件监听配置
              </h3>
              
              <div className="bg-slate-900/50 p-4 rounded-lg border border-white/5 space-y-4">
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input 
                    type="checkbox" 
                    checked={formEmailConfig.enabled}
                    onChange={(e) => setFormEmailConfig({...formEmailConfig, enabled: e.target.checked})}
                    className="w-4 h-4 rounded border-white/10 bg-slate-800 text-pink-500 focus:ring-pink-500/50"
                  />
                  <span className="text-sm text-slate-200 group-hover:text-white transition-colors">启用定时监听邮件</span>
                </label>
                
                {formEmailConfig.enabled && (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-slate-400 mb-1 block">IMAP 服务器</label>
                        <input 
                          type="text" 
                          value={formEmailConfig.host}
                          onChange={(e) => setFormEmailConfig({...formEmailConfig, host: e.target.value})}
                          placeholder="imap.example.com"
                          className="w-full bg-black/30 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-pink-500 outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-slate-400 mb-1 block">端口</label>
                          <input 
                            type="number" 
                            value={formEmailConfig.port}
                            onChange={(e) => setFormEmailConfig({...formEmailConfig, port: Number(e.target.value)})}
                            className="w-full bg-black/30 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-pink-500 outline-none"
                          />
                        </div>
                        <div className="flex items-end pb-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input 
                              type="checkbox" 
                              checked={formEmailConfig.ssl}
                              onChange={(e) => setFormEmailConfig({...formEmailConfig, ssl: e.target.checked})}
                              className="rounded border-white/10 bg-slate-800 text-pink-500 focus:ring-pink-500/50"
                            />
                            <span className="text-xs text-slate-300">SSL/TLS</span>
                          </label>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-slate-400 mb-1 block">邮箱账号</label>
                        <input 
                          type="text" 
                          value={formEmailConfig.user}
                          onChange={(e) => setFormEmailConfig({...formEmailConfig, user: e.target.value})}
                          placeholder="user@example.com"
                          className="w-full bg-black/30 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-pink-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 mb-1 block">授权码/密码</label>
                        <input 
                          type="password" 
                          value={formEmailConfig.pass}
                          onChange={(e) => setFormEmailConfig({...formEmailConfig, pass: e.target.value})}
                          placeholder="••••••••"
                          className="w-full bg-black/30 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-pink-500 outline-none"
                        />
                      </div>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-slate-400 block">监听文件夹 (默认 INBOX)</label>
                        <button
                          onClick={handleFetchFolders}
                          disabled={loadingFolders}
                          className="text-xs text-pink-400 hover:text-pink-300 transition-colors disabled:opacity-50 flex items-center gap-1"
                        >
                          {loadingFolders ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                          自动同步
                        </button>
                      </div>
                      
                      {folderError && <div className="text-xs text-red-400">{folderError}</div>}
                      
                      {availableFolders.length > 0 ? (
                        <div className="bg-black/30 border border-white/10 rounded p-3 max-h-32 overflow-y-auto custom-scrollbar flex flex-wrap gap-2">
                          {availableFolders.map(folder => {
                            const isSelected = formEmailConfig.targetFolder.split(',').includes(folder);
                            return (
                              <label key={folder} className="flex items-center gap-1.5 cursor-pointer bg-slate-800/50 hover:bg-slate-700/50 px-2 py-1 rounded border border-white/5 transition-colors">
                                <input 
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    const current = formEmailConfig.targetFolder.split(',').filter(Boolean);
                                    let next;
                                    if (e.target.checked) {
                                      next = [...current, folder];
                                    } else {
                                      next = current.filter(f => f !== folder);
                                    }
                                    setFormEmailConfig({...formEmailConfig, targetFolder: next.join(',')});
                                  }}
                                  className="w-3 h-3 rounded border-white/10 bg-slate-800 text-pink-500 focus:ring-pink-500/50"
                                />
                                <span className="text-xs text-slate-300">{decodeIMAPFolder(folder)}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <input 
                            type="text" 
                            readOnly
                            value={formEmailConfig.targetFolder.split(',').map(f => decodeIMAPFolder(f)).join(',')}
                            className="w-full bg-black/30 border border-white/10 rounded p-2 text-sm text-slate-200 focus:outline-none cursor-default"
                          />
                          <input 
                            type="text" 
                            value={formEmailConfig.targetFolder}
                            onChange={(e) => setFormEmailConfig({...formEmailConfig, targetFolder: e.target.value})}
                            placeholder="如 INBOX, 或者点击右上角自动同步"
                            className="w-full bg-transparent border-none p-0 text-[10px] text-slate-500 focus:ring-0 outline-none font-mono"
                          />
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400 block mb-1">定时执行周期</label>
                        <div className="flex gap-2 flex-wrap">
                          {['日', '一', '二', '三', '四', '五', '六'].map((day, idx) => (
                            <label key={idx} className="flex items-center gap-1 cursor-pointer">
                              <input 
                                type="checkbox"
                                checked={formEmailConfig.scheduleDays.includes(idx)}
                                onChange={(e) => {
                                  const newDays = e.target.checked 
                                    ? [...formEmailConfig.scheduleDays, idx].sort()
                                    : formEmailConfig.scheduleDays.filter(d => d !== idx);
                                  setFormEmailConfig({...formEmailConfig, scheduleDays: newDays});
                                }}
                                className="w-3 h-3 rounded border-white/10 bg-slate-800 text-pink-500 focus:ring-pink-500/50"
                              />
                              <span className="text-[11px] text-slate-300">周{day}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 mb-1 block">执行时间/间隔</label>
                        <select 
                          value={formEmailConfig.scheduleTime}
                          onChange={(e) => setFormEmailConfig({...formEmailConfig, scheduleTime: e.target.value})}
                          className="w-full bg-black/30 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-pink-500 outline-none"
                        >
                          <option value="every_1h">每 1 小时执行一次</option>
                          <option value="every_3h">每 3 小时执行一次</option>
                          <option value="09:00">每天 09:00 定时执行</option>
                          <option value="10:00">每天 10:00 定时执行</option>
                          <option value="12:00">每天 12:00 定时执行</option>
                          <option value="18:00">每天 18:00 定时执行</option>
                        </select>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4 border-t border-white/5 pt-3">
                       <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                          <input 
                            type="checkbox" 
                            checked={formEmailConfig.markAsRead}
                            onChange={(e) => setFormEmailConfig({...formEmailConfig, markAsRead: e.target.checked})}
                            className="rounded border-white/10 bg-slate-800 text-pink-500 focus:ring-pink-500/50"
                          />
                          处理成功后标记为已读
                       </label>
                       
                       <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                          <input 
                            type="checkbox" 
                            checked={formEmailConfig.autoSyncToNotion}
                            onChange={(e) => setFormEmailConfig({...formEmailConfig, autoSyncToNotion: e.target.checked})}
                            className="rounded border-white/10 bg-slate-800 text-pink-500 focus:ring-pink-500/50"
                          />
                          自动同步待办至 Notion
                       </label>
                    </div>

                    <div className="flex gap-4 border-t border-white/5 pt-3">
                       <label className="flex flex-col gap-1 text-xs text-slate-300 w-1/2">
                          <span>自动抓取回溯天数 (Auto)</span>
                          <input 
                            type="number" 
                            min="1" max="365"
                            value={formEmailConfig.autoReadDays || 3}
                            onChange={(e) => setFormEmailConfig({...formEmailConfig, autoReadDays: parseInt(e.target.value) || 3})}
                            className="bg-black/30 border border-white/10 rounded p-1.5 text-slate-200 focus:ring-1 focus:ring-pink-500 outline-none w-full"
                          />
                       </label>
                       
                       <label className="flex flex-col gap-1 text-xs text-slate-300 w-1/2">
                          <span>手动抓取回溯天数 (Manual)</span>
                          <input 
                            type="number" 
                            min="1" max="365"
                            value={formEmailConfig.manualReadDays || 7}
                            onChange={(e) => setFormEmailConfig({...formEmailConfig, manualReadDays: parseInt(e.target.value) || 7})}
                            className="bg-black/30 border border-white/10 rounded p-1.5 text-slate-200 focus:ring-1 focus:ring-pink-500 outline-none w-full"
                          />
                       </label>
                    </div>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                ⚠️ 由于安全策略限制，QQ 邮箱、163 邮箱等大多需要使用独立的“授权码”而非登录密码。请前往对应的 Web 邮箱设置中生成。
              </p>
            </div>
          </div>

          {/* --- TAB: Integrations --- */}
          <div className={`space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 ${activeTab !== 'integration' ? 'hidden' : ''}`}>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-orange-300 flex items-center gap-2">
                  <Database className="w-4 h-4" /> Notion 推送配置
                </h3>
                <button 
                  onClick={handleTestNotion}
                  disabled={testingNotion}
                  className="text-xs flex items-center gap-1 bg-orange-500/20 text-orange-300 px-2 py-1 rounded hover:bg-orange-500/30 transition disabled:opacity-50"
                >
                  {testingNotion ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  同步结构并测试
                </button>
              </div>
              {notionTestResult === 'success' && (
                <div className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 p-2 rounded border border-green-500/20">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 数据库连接成功！已同步字段结构。
                </div>
              )}
              {notionTestResult === 'error' && (
                <div className="flex items-center gap-1 text-xs text-red-400 bg-red-500/10 p-2 rounded border border-red-500/20">
                  <XCircle className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">失败: {notionTestErrorMsg}</span>
                </div>
              )}
              <div className="grid gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Notion API Key</label>
                  <div className="relative">
                    <Key className="w-4 h-4 absolute left-2 top-2.5 text-slate-500" />
                    <input 
                      type="password" value={formNotionKey} onChange={e => setFormNotionKey(e.target.value)}
                      className="w-full bg-slate-900/50 border border-white/10 rounded p-2 pl-8 text-sm text-slate-200 focus:ring-1 focus:ring-orange-500 outline-none"
                      placeholder="secret_..."
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Target Database ID</label>
                  <input 
                    type="text" value={formNotionDb} onChange={e => setFormNotionDb(e.target.value)}
                    className="w-full bg-slate-900/50 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-orange-500 outline-none"
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  />
                </div>
              </div>
              <p className="text-[11px] text-orange-400/80 mt-1">
                ⚠️ 必做：请务必在 Notion 数据库页面右上角的「...」-&gt;「Connections」中，将此 Integration 邀请进来允许访问，否则将报 404/Not Found 错误！
              </p>

              {notionProperties && notionProperties.length > 0 && (() => {
                const sortedProps = [...notionProperties].sort((a, b) => {
                  const orderA = formFieldMappings[a.id]?.order ?? 999;
                  const orderB = formFieldMappings[b.id]?.order ?? 999;
                  return orderA - orderB;
                });
                
                const moveField = (index: number, direction: 'up' | 'down') => {
                  if (direction === 'up' && index > 0) {
                    const newMappings = { ...formFieldMappings };
                    const currId = sortedProps[index].id;
                    const prevId = sortedProps[index - 1].id;
                    const temp = newMappings[currId].order;
                    newMappings[currId].order = newMappings[prevId].order;
                    newMappings[prevId].order = temp;
                    setFormFieldMappings(newMappings);
                  } else if (direction === 'down' && index < sortedProps.length - 1) {
                    const newMappings = { ...formFieldMappings };
                    const currId = sortedProps[index].id;
                    const nextId = sortedProps[index + 1].id;
                    const temp = newMappings[currId].order;
                    newMappings[currId].order = newMappings[nextId].order;
                    newMappings[nextId].order = temp;
                    setFormFieldMappings(newMappings);
                  }
                };

                const enabledSortedProps = sortedProps.filter(p => formFieldMappings[p.id]?.enabled);

                return (
                  <div className="mt-4 border-t border-white/5 pt-4">
                    <h4 className="text-xs font-medium text-slate-300 mb-2 flex justify-between items-center">
                      <span>可同步的数据库字段 (Database Properties)</span>
                    </h4>
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                      {sortedProps.map((prop, idx) => {
                        const mapping = formFieldMappings[prop.id] || { notionPropId: prop.id, enabled: false, aiHint: '', order: idx };
                        return (
                          <div key={prop.id} className="bg-slate-900/40 p-2 rounded border border-white/5 flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <input 
                                  type="checkbox" 
                                  checked={mapping.enabled}
                                  onChange={e => {
                                    if (prop.type === 'title') return;
                                    setFormFieldMappings({
                                      ...formFieldMappings,
                                      [prop.id]: { ...mapping, enabled: e.target.checked }
                                    });
                                  }}
                                  className={`w-3.5 h-3.5 rounded bg-slate-800 border-slate-600 text-orange-500 focus:ring-orange-500 focus:ring-offset-slate-900 ${prop.type === 'title' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                                />
                                <span className="text-xs text-slate-300 font-medium">{prop.name}</span>
                                <span className="text-[10px] text-slate-500 bg-slate-800 px-1 rounded">{prop.type}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <button onClick={() => moveField(idx, 'up')} disabled={idx === 0} className="p-1 hover:bg-white/10 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors">
                                  <ArrowUp className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => moveField(idx, 'down')} disabled={idx === sortedProps.length - 1} className="p-1 hover:bg-white/10 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors">
                                  <ArrowDown className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                            
                            {mapping.enabled && prop.type !== 'title' && (
                              <input 
                                type="text"
                                value={mapping.aiHint}
                                onChange={e => {
                                  setFormFieldMappings({
                                    ...formFieldMappings,
                                    [prop.id]: { ...mapping, aiHint: e.target.value }
                                  });
                                }}
                                placeholder="给 AI 的提取建议 (例如: 必须是某某人名，如果没有提及留空)"
                                className="text-xs bg-slate-800/50 border border-white/5 rounded px-2 py-1 text-slate-300 outline-none focus:border-orange-500/50 w-full"
                              />
                            )}

                            {mapping.enabled && prop.options && prop.options.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                <span className="text-[10px] text-slate-500 mt-0.5">已同步选项:</span>
                                {prop.options.map(opt => (
                                  <span key={opt} className="text-[10px] bg-slate-800 border border-white/10 text-slate-300 px-1.5 py-0.5 rounded">
                                    {opt}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    
                    {/* Preview Section */}
                    {enabledSortedProps.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-dashed border-white/10">
                        <h4 className="text-xs text-orange-400 mb-2 font-medium">UI 拼装预览</h4>
                        <div className="flex items-center gap-2 bg-slate-900/80 p-2 rounded border border-white/5 overflow-x-auto custom-scrollbar opacity-80">
                          <input type="checkbox" className="w-4 h-4 rounded border-white/10 bg-slate-800 shrink-0" checked readOnly />
                          {enabledSortedProps.map(f => {
                            if (f.type === 'title' || f.type === 'rich_text') {
                              return <input key={f.id} type="text" value={f.name} className="flex-1 min-w-[120px] bg-transparent text-sm border-b border-purple-500/50 px-1 text-slate-300" readOnly />;
                            } else if (f.type === 'select') {
                              return <div key={f.id} className="text-xs font-mono text-purple-400 bg-purple-500/10 px-1.5 py-1 rounded max-w-[80px] truncate text-center border-b border-purple-500/30 shrink-0 whitespace-nowrap">{f.name}</div>;
                            } else if (f.type === 'date') {
                              return <div key={f.id} className="text-xs text-slate-300 bg-white/5 border border-white/10 px-1.5 py-1 rounded shrink-0 whitespace-nowrap">yyyy-mm-dd</div>;
                            } else if (f.type === 'checkbox') {
                              return <div key={f.id} className="flex items-center gap-1 text-xs text-slate-400 shrink-0 whitespace-nowrap"><input type="checkbox" className="rounded bg-slate-800 border-slate-600 shrink-0" />{f.name}</div>;
                            } else {
                              return <div key={f.id} className="min-w-[60px] bg-transparent text-xs border-b border-white/10 text-slate-400 px-1 text-center shrink-0 whitespace-nowrap overflow-hidden text-ellipsis">{f.name}</div>;
                            }
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* --- TAB: System --- */}
          <div className={`space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 ${activeTab !== 'system' ? 'hidden' : ''}`}>
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-teal-300 flex items-center gap-2">
                <Keyboard className="w-4 h-4" /> 系统及快捷键
              </h3>
              <div className="grid gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-slate-400">唤醒/隐藏 快捷键</label>
                    {formGlobalShortcut !== 'Alt+Space' && (
                      <button 
                        onClick={() => {
                          setFormGlobalShortcut('Alt+Space');
                          setLiveShortcut('');
                          setIsRecordingShortcut(false);
                        }}
                        className="text-xs text-slate-400 hover:text-teal-400 transition-colors flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" /> 恢复默认 (Alt+Space)
                      </button>
                    )}
                  </div>
                  <div 
                    tabIndex={0}
                    onFocus={() => setIsRecordingShortcut(true)}
                    onBlur={() => setIsRecordingShortcut(false)}
                    onKeyDown={handleKeyDown}
                    onKeyUp={handleKeyUp}
                    className={`w-full bg-slate-900/50 border rounded p-3 flex items-center min-h-[46px] cursor-pointer outline-none transition-all ${isRecordingShortcut ? 'border-teal-500 ring-1 ring-teal-500/50 shadow-[0_0_15px_rgba(20,184,166,0.2)]' : 'border-white/10 hover:border-white/20'}`}
                    title="点击此处后直接按下您想使用的组合键（如 Ctrl+Shift+S）"
                  >
                    {isRecordingShortcut ? (
                      <div className="flex items-center gap-2">
                        {liveShortcut ? (
                          <>
                            {liveShortcut.split('+').map((key, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <kbd className="px-2 py-1 bg-teal-500/20 border border-teal-500/30 rounded-md text-sm text-teal-300 shadow-sm font-medium font-mono min-w-[30px] text-center">
                                  {key}
                                </kbd>
                                {i < liveShortcut.split('+').length - 1 && (
                                  <span className="text-teal-500/50 text-xs font-bold">+</span>
                                )}
                              </div>
                            ))}
                            <span className="text-teal-500/50 text-xs font-bold">+</span>
                            <span className="text-sm text-teal-400 animate-pulse ml-1">...</span>
                          </>
                        ) : (
                          <span className="text-sm text-teal-400 animate-pulse flex items-center gap-2">
                            <Keyboard className="w-4 h-4" /> 请直接按下新的快捷键组合 (按 Esc 取消)
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        {formGlobalShortcut.split('+').map((key, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <kbd className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-md text-sm text-slate-200 shadow-sm font-medium font-mono min-w-[30px] text-center">
                              {key}
                            </kbd>
                            {i < formGlobalShortcut.split('+').length - 1 && (
                              <span className="text-slate-500 text-xs font-bold">+</span>
                            )}
                          </div>
                        ))}
                        <span className="ml-3 text-xs text-slate-500 px-2 py-1 bg-white/5 rounded-full hover:bg-white/10 transition-colors">点击重新录制</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between bg-slate-900/50 p-3 rounded border border-white/10 hover:border-white/20 transition-colors mt-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="enableWindowMode" className="text-sm font-medium text-slate-200 cursor-pointer">
                      启用窗口化模式 (常驻桌面)
                    </label>
                    <span className="text-xs text-slate-500">
                      开启后，失去焦点时界面将不再自动隐藏，并在右上角显示窗口控制按钮。
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    id="enableWindowMode"
                    checked={formWindowMode}
                    onChange={(e) => setFormWindowMode(e.target.checked)}
                    className="w-5 h-5 rounded border-white/20 bg-black/20 text-teal-500 focus:ring-teal-500/50 cursor-pointer"
                  />
                </div>
              </div>
            </div>
            
            <div className="h-px bg-white/5 w-full"></div>

            {/* Advanced Settings */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-slate-400 flex items-center gap-2">
                <Settings className="w-4 h-4" /> 高级设置
              </h3>
              
              <div className="grid gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">长文本解析 Token 保护截断上限 (字符数)</label>
                  <input 
                    type="number" value={formTokenLimit} onChange={e => setFormTokenLimit(Number(e.target.value))}
                    className="w-full bg-slate-900/50 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-teal-500 outline-none"
                    placeholder="8000"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    默认 8000。如果输入文本过长，会被自动截断，防止超长 PDF 解析造成天价账单或引发报错。
                  </p>
                </div>
              </div>
              
              <div className="bg-white/5 p-3 rounded border border-white/10 mt-2">
                <p className="text-xs text-slate-400 leading-relaxed">
                  💡 <strong className="text-slate-300">关于时间推算</strong>：系统在提取待办时，已在底层向大模型注入了您系统当前的真实时间。因此您可以随意在文本中使用“明天”、“下周五”、“月底”等相对时间描述，系统均能精准解析为标准日期格式。
                </p>
              </div>
            </div>

            <div className="h-px bg-white/5 w-full"></div>

            {/* Dev Settings */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-slate-400 flex items-center gap-2">
                <Terminal className="w-4 h-4" /> 开发调测配置
              </h3>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input 
                    type="checkbox" 
                    checked={formLogging} 
                    onChange={(e) => setFormLogging(e.target.checked)}
                    className="w-4 h-4 rounded border-white/10 bg-slate-900/50 text-purple-500 focus:ring-purple-500/50 focus:ring-offset-0 transition-colors"
                  />
                  <span className="text-sm text-slate-300 group-hover:text-white transition-colors">开启本地详细日志记录</span>
                </label>
                <div className="flex gap-2">
                  <button 
                    onClick={() => import('@tauri-apps/api/core').then(m => m.invoke('open_log_file')).catch(e => console.error(e))}
                    className="text-xs text-blue-400 hover:text-blue-300 transition bg-blue-500/10 hover:bg-blue-500/20 px-2 py-1 rounded"
                  >
                    打开日志文件
                  </button>
                  <button 
                    onClick={async (e) => {
                      const btn = e.currentTarget;
                      const originalText = btn.innerText;
                      try {
                        const m = await import('@tauri-apps/api/core');
                        await m.invoke('clear_log');
                        btn.innerText = '已清空！';
                      } catch {
                        btn.innerText = '清空失败';
                      }
                      setTimeout(() => { btn.innerText = originalText; }, 2000);
                    }}
                    className="text-xs text-red-400 hover:text-red-300 transition bg-red-500/10 hover:bg-red-500/20 px-2 py-1 rounded min-w-[64px]"
                  >
                    清空日志
                  </button>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="flex-none pt-4 mt-2 border-t border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <p className="text-[10px] text-slate-500/80 leading-relaxed max-w-md">
            🔒 <strong className="font-medium text-slate-400">隐私与数据声明</strong><br/>
            所有文件（PDF/Word/Excel 等）的解析读取 100% 在本地沙箱执行。提取和润色过程会调用您配置的 API Base URL 发送请求，请勿向不受信任的服务端发送机密信息。
          </p>
          <button 
            data-testid="save-settings"
            onClick={handleSave}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-purple-600 hover:bg-purple-500 text-white rounded-md shadow-lg shadow-purple-500/20 transition-all active:scale-95 shrink-0 whitespace-nowrap self-end sm:self-auto"
          >
            <Save className="w-4 h-4" />
            <span>保存设置</span>
          </button>
        </div>

        </div>
      </div>

      {/* Zen Expand Editor Modal for Personal Focus */}
      <ZenEditorModal
        isOpen={isFocusEditorOpen}
        title="沉浸式编辑：个人关注方向 (待办提取规则)"
        value={formStaticFocus}
        placeholder="例如：我是一名前端开发，请侧重提取关于 UI、交互、接口联调的待办..."
        onSave={(newVal) => {
          setFormStaticFocus(newVal);
          if (previousFocus !== null && newVal !== previousFocus) {
            setPreviousFocus(null);
          }
        }}
        onClose={() => setIsFocusEditorOpen(false)}
        showAiOptimize={true}
        onAiOptimize={handleOptimizePrompt}
        isOptimizing={optimizingPrompt}
        canUndo={previousFocus !== null}
        onUndo={() => {
          if (previousFocus !== null) {
            setFormStaticFocus(previousFocus);
            setPreviousFocus(null);
          }
        }}
      />

      {confirmDialog.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}>
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6 max-w-sm w-full shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{confirmDialog.message}</p>
            <div className="flex justify-end gap-3 pt-2">
              {!confirmDialog.isAlert && (
                <button 
                  onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  取消
                </button>
              )}
              <button 
                onClick={confirmDialog.onConfirm}
                className={`px-4 py-2 rounded-lg text-sm font-medium text-white shadow-lg transition active:scale-95 ${confirmDialog.isAlert ? 'bg-blue-600/90 hover:bg-blue-500 shadow-blue-500/20' : 'bg-amber-600/90 hover:bg-amber-500 shadow-amber-500/20'}`}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
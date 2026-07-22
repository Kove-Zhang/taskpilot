import { useState } from 'react'
import { X, Save, Key, Database, BrainCircuit, Wand2, Terminal, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { useSettingsStore } from './store'
import { logger } from './lib/logger'
import { fetch } from '@tauri-apps/plugin-http'

interface SettingsPanelProps {
  onClose: () => void;
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const {
    apiBaseUrl, apiKey, modelName, personalFocus, notionApiKey, notionDatabaseId, enableLogging,
    setApiSettings, setPersonalFocus, setNotionSettings, setEnableLogging
  } = useSettingsStore();

  const [formBaseUrl, setFormBaseUrl] = useState(apiBaseUrl);
  const [formApiKey, setFormApiKey] = useState(apiKey);
  const [formModelName, setFormModelName] = useState(modelName);
  const [formFocus, setFormFocus] = useState(personalFocus);
  const [formNotionKey, setFormNotionKey] = useState(notionApiKey);
  const [formNotionDb, setFormNotionDb] = useState(notionDatabaseId);
  const [formLogging, setFormLogging] = useState(enableLogging);

  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<'none' | 'success' | 'error'>('none');
  const [testErrorMsg, setTestErrorMsg] = useState('');

  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [previousFocus, setPreviousFocus] = useState<string | null>(null);

  const [testingNotion, setTestingNotion] = useState(false);
  const [notionTestResult, setNotionTestResult] = useState<'none' | 'success' | 'error'>('none');
  const [notionTestErrorMsg, setNotionTestErrorMsg] = useState('');

  const handleSave = () => {
    setApiSettings(formBaseUrl, formApiKey, formModelName);
    setPersonalFocus(formFocus);
    setNotionSettings(formNotionKey, formNotionDb);
    setEnableLogging(formLogging);
    logger.info('Settings saved.');
    onClose();
  };

  const handleTestConnection = async () => {
    if (!formBaseUrl || !formApiKey) {
      setTestResult('error');
      setTestErrorMsg('请填写 API Base URL 和 API Key');
      return;
    }
    
    setTestingConnection(true);
    setTestResult('none');
    setTestErrorMsg('');
    
    try {
      logger.info('Testing API connection...', { baseUrl: formBaseUrl, model: formModelName });
      const response = await fetch(`${formBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${formApiKey}`
        },
        body: JSON.stringify({
          model: formModelName,
          messages: [{ role: 'user', content: 'Say "OK" if you receive this.' }],
          max_tokens: 5
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP Error ${response.status}`);
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0) {
        setTestResult('success');
        logger.info('API connection test successful', data);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      setTestResult('error');
      setTestErrorMsg(msg);
      logger.error('API connection test failed', msg);
    } finally {
      setTestingConnection(false);
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
      const response = await fetch(`https://api.notion.com/v1/databases/${formNotionDb}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${formNotionKey}`,
          'Notion-Version': '2025-09-03'
        }
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || `HTTP Error ${response.status}`);
      }

      await response.json();
      setNotionTestResult('success');
      logger.info('Notion connection test successful');
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
    if (!formBaseUrl || !formApiKey || !formModelName) {
      alert("请先配置并保存上方的大模型信息！");
      return;
    }
    if (!formFocus.trim()) {
      alert("请先输入简单的关注方向描述，AI 才能帮您润色。");
      return;
    }

    setOptimizingPrompt(true);
    try {
      const response = await fetch(`${formBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${formApiKey}`
        },
        body: JSON.stringify({
          model: formModelName,
          messages: [{
            role: 'system',
            content: '你是一个资深的 Prompt Engineer。请将用户输入的一段简单的任务关注点描述，润色为一段结构清晰、语气专业且指令明确的「系统提示词（System Prompt）」，用于指导另一个大模型精准提取相关待办事项。\n\n【项目背景要求】\n你的润色结果将被注入到本系统的主 Prompt 中。主 Prompt 已经强制要求模型以 JSON 格式输出待办事项，且只包含 `title`(标题), `priority`(优先级), `planned_date`(计划日期) 字段。因此，你的润色内容应专注于**提取规则、业务逻辑、内容过滤标准、优先级评判倾向**等，**绝对不要**包含关于输出格式（如 JSON、Markdown、字段定义）的指令。\n\n【关键约束】\n1. 表达必须清晰、明确、严谨。\n2. 绝对不可额外捏造或增添用户未说明的背景、领域知识或未提及的业务要求。\n3. 仅做形式上的专业化改写，直接输出润色后的提示词，绝不要包含任何开场白或解释。'
          }, {
            role: 'user',
            content: formFocus
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}`);
      }

      const data = await response.json();
      logger.info('Received raw prompt optimization response from AI', { response: data });
      if (data.choices && data.choices.length > 0) {
        setPreviousFocus(formFocus);
        setFormFocus(data.choices[0].message.content.trim());
        logger.info('Prompt optimization successful');
      }
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      logger.error('Prompt optimization failed', msg);
      alert(`润色失败: ${msg}`);
    } finally {
      setOptimizingPrompt(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="glass-panel w-full max-w-lg p-6 flex flex-col gap-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-purple-400" />
            全局设置
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-md transition-colors text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col gap-5 overflow-y-auto max-h-[60vh] pr-2 custom-scrollbar">
          
          {/* AI Settings */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-purple-300 flex items-center gap-2">
                <BrainCircuit className="w-4 h-4" /> AI 大模型配置
              </h3>
              <button 
                onClick={handleTestConnection}
                disabled={testingConnection}
                className="text-xs flex items-center gap-1 bg-purple-500/20 text-purple-300 px-2 py-1 rounded hover:bg-purple-500/30 transition disabled:opacity-50"
              >
                {testingConnection ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                测试连接
              </button>
            </div>
            {testResult === 'success' && (
              <div className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 p-2 rounded border border-green-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" /> 连接成功，模型响应正常！
              </div>
            )}
            {testResult === 'error' && (
              <div className="flex items-center gap-1 text-xs text-red-400 bg-red-500/10 p-2 rounded border border-red-500/20">
                <XCircle className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">失败: {testErrorMsg}</span>
              </div>
            )}
            <div className="grid gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">API Base URL</label>
                <input 
                  type="text" value={formBaseUrl} onChange={e => setFormBaseUrl(e.target.value)}
                  className="w-full bg-slate-900/50 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-purple-500 outline-none"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">API Key</label>
                <input 
                  type="password" value={formApiKey} onChange={e => setFormApiKey(e.target.value)}
                  className="w-full bg-slate-900/50 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-purple-500 outline-none"
                  placeholder="sk-..."
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Model Name (多模态)</label>
                <input 
                  type="text" value={formModelName} onChange={e => setFormModelName(e.target.value)}
                  className="w-full bg-slate-900/50 border border-white/10 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-purple-500 outline-none"
                  placeholder="gpt-4o"
                />
              </div>
            </div>
          </div>

          <div className="h-px bg-white/5 w-full"></div>

          {/* Personal Focus */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-blue-300 flex items-center gap-2">
                <Wand2 className="w-4 h-4" /> 个人关注方向
              </h3>
              <div className="flex items-center gap-2">
                {previousFocus !== null && (
                  <button
                    onClick={() => {
                      setFormFocus(previousFocus);
                      setPreviousFocus(null);
                    }}
                    className="text-xs flex items-center gap-1 bg-slate-500/20 text-slate-300 px-2 py-1 rounded hover:bg-slate-500/40 transition"
                    title="撤销刚才的润色结果，恢复原文本"
                  >
                    <Undo2 className="w-3 h-3" />
                    撤销润色
                  </button>
                )}
                <button
                  onClick={handleOptimizePrompt}
                  disabled={optimizingPrompt || !formFocus.trim()}
                  className="text-xs flex items-center gap-1 bg-blue-500/20 text-blue-300 px-2 py-1 rounded hover:bg-blue-500/30 transition disabled:opacity-50"
                  title="让 AI 帮您润色和扩充提示词"
                >
                  {optimizingPrompt ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  AI 智能润色
                </button>
              </div>
            </div>
            <textarea 
              value={formFocus} onChange={e => {
                setFormFocus(e.target.value);
                if (previousFocus !== null) setPreviousFocus(null);
              }}
              className="w-full bg-slate-900/50 border border-white/10 rounded p-2 text-sm text-slate-200 min-h-[120px] resize-none focus:ring-1 focus:ring-blue-500 outline-none"
              placeholder="例如：我是一名前端开发，请侧重提取关于 UI、交互、接口联调的待办..."
            />
          </div>

          <div className="h-px bg-white/5 w-full"></div>

          {/* Notion Settings */}
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
                测试连接
              </button>
            </div>
            {notionTestResult === 'success' && (
              <div className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 p-2 rounded border border-green-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" /> 数据库连接成功！
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
              <button 
                onClick={() => import('@tauri-apps/api/core').then(m => m.invoke('open_log_file')).catch(e => console.error(e))}
                className="text-xs text-blue-400 hover:text-blue-300 transition bg-blue-500/10 hover:bg-blue-500/20 px-2 py-1 rounded"
              >
                打开日志文件
              </button>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="pt-2 border-t border-white/10 flex justify-end">
          <button 
            onClick={handleSave}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-purple-600 hover:bg-purple-500 text-white rounded-md shadow-lg shadow-purple-500/20 transition-all active:scale-95"
          >
            <Save className="w-4 h-4" />
            <span>保存设置</span>
          </button>
        </div>

      </div>
    </div>
  )
}

function SettingsIcon(props: any) {
  return <Settings className={props.className} />
}
import { Settings, Sparkles, Undo2 } from 'lucide-react'

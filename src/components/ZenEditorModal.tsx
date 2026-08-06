import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Maximize2, X, Sparkles, Undo2, Loader2, Save, FileText, AlertTriangle } from 'lucide-react';

export interface ZenEditorModalProps {
  isOpen: boolean;
  title: string;
  value: string;
  placeholder?: string;
  onSave: (newValue: string) => void;
  onClose: () => void;
  showAiOptimize?: boolean;
  onAiOptimize?: () => void;
  isOptimizing?: boolean;
  canUndo?: boolean;
  onUndo?: () => void;
}

export const ZenEditorModal: React.FC<ZenEditorModalProps> = ({
  isOpen,
  title,
  value,
  placeholder = '请在此输入内容...',
  onSave,
  onClose,
  showAiOptimize = false,
  onAiOptimize,
  isOptimizing = false,
  canUndo = false,
  onUndo,
}) => {
  const [text, setText] = useState(value);
  const [showDirtyConfirm, setShowDirtyConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync value when modal opens or value prop updates from AI optimization
  useEffect(() => {
    if (isOpen) {
      setText(value);
      setShowDirtyConfirm(false);
      // Automatically focus and move cursor to the end
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = textareaRef.current.value.length;
        }
      }, 50);
    }
  }, [isOpen, value]);

  const isDirty = text !== value;
  const charCount = text.length;
  const lineCount = text ? text.split('\n').length : 0;

  const handleAttemptClose = useCallback(() => {
    if (isDirty) {
      setShowDirtyConfirm(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const handleSave = useCallback(() => {
    onSave(text);
    onClose();
  }, [onClose, onSave, text]);

  // Keyboard shortcut: Ctrl+Enter or Cmd+Enter to save, Esc to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (showDirtyConfirm) {
          setShowDirtyConfirm(false);
        } else {
          handleAttemptClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleAttemptClose, handleSave, isOpen, showDirtyConfirm]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
      {/* Backdrop with backdrop-blur */}
      <div 
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-md transition-opacity" 
        onClick={handleAttemptClose}
      />

      {/* Main Modal Window (Golden Ratio / Large Viewport) */}
      <div className="relative w-full max-w-4xl h-[88vh] max-h-[700px] bg-slate-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-slate-900/80">
          <div className="flex items-center gap-2 text-blue-300 font-medium">
            <Maximize2 className="w-5 h-5 text-indigo-400" />
            <span>{title}</span>
          </div>

          <div className="flex items-center gap-4">
            {/* Stats Badge */}
            <div className="flex items-center gap-3 bg-slate-800/80 px-3 py-1 rounded-full border border-white/5 text-xs text-slate-400">
              <span className="flex items-center gap-1">
                <FileText className="w-3.5 h-3.5 text-slate-500" />
                字数: <strong className="text-slate-200 font-mono">{charCount}</strong>
              </span>
              <span className="text-white/20">|</span>
              <span>
                行数: <strong className="text-slate-200 font-mono">{lineCount}</strong>
              </span>
            </div>

            {/* Close Button */}
            <button
              onClick={handleAttemptClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition"
              title="关闭或退出 (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Center Editor Area */}
        <div className="flex-1 relative flex flex-col p-6 bg-slate-950/50">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            className="w-full flex-1 bg-transparent text-slate-200 text-base leading-relaxed resize-none focus:outline-none font-sans placeholder:text-slate-600 custom-scrollbar"
            style={{ tabSize: 2 }}
          />

          {/* Dirty Confirm Overlay */}
          {showDirtyConfirm && (
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150 z-20">
              <div className="bg-slate-900 border border-amber-500/30 rounded-xl p-6 max-w-md w-full shadow-2xl text-center space-y-4">
                <div className="w-12 h-12 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto text-amber-400">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-base font-medium text-slate-200">检测到未保存的修改</h4>
                  <p className="text-sm text-slate-400">
                    您已对内容进行了修改但尚未保存。现在退出将丢失当前更改，是否确认放弃？
                  </p>
                </div>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    onClick={() => setShowDirtyConfirm(false)}
                    className="flex-1 px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition text-sm font-medium"
                  >
                    返回继续编辑
                  </button>
                  <button
                    onClick={() => {
                      setShowDirtyConfirm(false);
                      onClose();
                    }}
                    className="flex-1 px-4 py-2 rounded-lg bg-red-600/80 text-white hover:bg-red-600 transition text-sm font-medium"
                  >
                    放弃更改并退出
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Footer Area */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10 bg-slate-900/90">
          {/* Left: AI features & hints */}
          <div className="flex items-center gap-3">
            {showAiOptimize && onAiOptimize && (
              <div className="flex items-center gap-2">
                {canUndo && onUndo && (
                  <button
                    onClick={onUndo}
                    className="text-xs flex items-center gap-1.5 bg-slate-800 text-slate-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 hover:text-white transition border border-white/5 shadow-sm"
                    title="撤销刚才的润色结果，恢复原文本"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    撤销润色
                  </button>
                )}
                <button
                  onClick={onAiOptimize}
                  disabled={isOptimizing || !text.trim()}
                  className="text-xs flex items-center gap-1.5 bg-blue-600/20 text-blue-300 px-3 py-1.5 rounded-lg hover:bg-blue-600/30 transition border border-blue-500/30 shadow-sm disabled:opacity-50"
                  title="让 AI 帮您润色和扩充当前提示词"
                >
                  {isOptimizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-blue-400" />}
                  AI 智能润色
                </button>
              </div>
            )}
            <span className="text-xs text-slate-500 hidden sm:inline-block ml-2">
              💡 快捷键: <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-slate-400 font-mono">Ctrl</kbd> + <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-slate-400 font-mono">Enter</kbd> 保存
            </span>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleAttemptClose}
              className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 transition"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-6 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-lg shadow-blue-500/20 transition transform active:scale-95"
            >
              <Save className="w-4 h-4" />
              保存并同步
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

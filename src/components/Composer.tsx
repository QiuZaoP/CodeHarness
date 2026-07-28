import { ArrowUp, AtSign, CircleStop, Paperclip, WandSparkles } from 'lucide-react';
import { type ChangeEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import { IconButton } from './IconButton';

export function Composer() {
  const { sendMessage, snapshot, controlTask } = useWorkspace();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);

  const activeSessionId = snapshot?.activeSessionId || '';
  const value = drafts[activeSessionId] || '';
  const filePaths = useMemo(() => {
    const collect = (nodes: NonNullable<typeof snapshot>['fileTree']): string[] =>
      nodes.flatMap((node) => (node.type === 'file' ? [node.path] : collect(node.children || [])));
    return snapshot ? collect(snapshot.fileTree) : [];
  }, [snapshot]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [activeSessionId, value]);

  if (!snapshot) return null;

  const submit = async () => {
    if (!value.trim() || sending || !activeSessionId) return;
    const message = value;
    setSubmitError(null);
    setDrafts((current) => ({ ...current, [activeSessionId]: '' }));
    setSending(true);
    try {
      await sendMessage(message);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Message could not be sent.');
      setDrafts((current) => ({ ...current, [activeSessionId]: message }));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const attachFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 32 * 1024) {
      setSubmitError('Attachments are limited to 32 KB of text.');
      return;
    }
    try {
      const content = await file.text();
      setDrafts((current) => ({
        ...current,
        [activeSessionId]: `${current[activeSessionId] || ''}${current[activeSessionId] ? '\n\n' : ''}[Attached: ${file.name}]\n${content}`
      }));
    } catch {
      setSubmitError('The selected file could not be read as text.');
    }
  };

  const isRunning = ['CREATED', 'PRECHECKING', 'PLANNING', 'EXECUTING', 'VERIFYING'].includes(
    snapshot.task.status
  );

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          key={snapshot.activeSessionId}
          ref={textareaRef}
          value={value}
          onChange={(event) =>
            setDrafts((current) => ({ ...current, [activeSessionId]: event.target.value }))
          }
          onKeyDown={onKeyDown}
          placeholder="Describe a task or continue the conversation"
          rows={1}
          aria-label="任务消息"
        />
        <input
          ref={attachmentRef}
          className="composer__file-input"
          type="file"
          accept="text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.java,.go,.css,.html,.yml,.yaml"
          onChange={attachFile}
        />
        <div className="composer__toolbar">
          <div className="composer__tools">
            <IconButton
              label="Add text attachment"
              size="small"
              onClick={() => attachmentRef.current?.click()}
            >
              <Paperclip size={16} />
            </IconButton>
            <IconButton
              label="Reference project file"
              size="small"
              onClick={() => setReferenceOpen((open) => !open)}
            >
              <AtSign size={16} />
            </IconButton>
            {referenceOpen ? (
              <select
                className="composer__reference-select"
                aria-label="Reference project file"
                defaultValue=""
                onChange={(event) => {
                  const filePath = event.target.value;
                  if (!filePath) return;
                  setDrafts((current) => ({
                    ...current,
                    [activeSessionId]: `${current[activeSessionId] || ''}${current[activeSessionId] ? ' ' : ''}@${filePath}`
                  }));
                  setReferenceOpen(false);
                }}
              >
                <option value="">Select file</option>
                {filePaths.map((filePath) => (
                  <option key={filePath} value={filePath}>
                    {filePath}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="composer__mode">
              <WandSparkles size={14} />
              Agent
            </span>
          </div>
          <div className="composer__submit-area">
            {isRunning ? (
              <IconButton
                label="停止当前任务"
                size="small"
                className="composer__stop"
                onClick={() => void controlTask('cancel')}
              >
                <CircleStop size={17} />
              </IconButton>
            ) : null}
            <button
              className="composer__send"
              aria-label="发送"
              title="发送"
              onClick={() => void submit()}
              disabled={!value.trim() || sending || !activeSessionId}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
      {submitError ? (
        <div className="composer__error" role="alert">
          {submitError}
        </div>
      ) : null}
    </div>
  );
}

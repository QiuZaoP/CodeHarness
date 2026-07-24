import {
  ArrowUp,
  AtSign,
  CircleStop,
  Paperclip,
  WandSparkles,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../state/WorkspaceContext";
import { IconButton } from "./IconButton";

export function Composer() {
  const { sendMessage, snapshot, controlTask } = useWorkspace();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSessionId = snapshot?.activeSessionId || "";
  const value = drafts[activeSessionId] || "";

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [activeSessionId, value]);

  if (!snapshot) {
    return null;
  }

  const submit = async () => {
    if (!value.trim() || sending) {
      return;
    }
    const message = value;
    setDrafts((current) => ({ ...current, [activeSessionId]: "" }));
    setSending(true);
    try {
      await sendMessage(message);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const isRunning = [
    "CREATED",
    "PRECHECKING",
    "PLANNING",
    "EXECUTING",
    "VERIFYING",
  ].includes(snapshot.task.status);

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          key={snapshot.activeSessionId}
          ref={textareaRef}
          value={value}
          onChange={(event) =>
            setDrafts((current) => ({
              ...current,
              [activeSessionId]: event.target.value,
            }))
          }
          onKeyDown={onKeyDown}
          placeholder="描述任务，或继续追问"
          rows={1}
          aria-label="任务消息"
        />
        <div className="composer__toolbar">
          <div className="composer__tools">
            <IconButton label="附加文件" size="small">
              <Paperclip size={16} />
            </IconButton>
            <IconButton label="引用文件或符号" size="small">
              <AtSign size={16} />
            </IconButton>
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
                onClick={() => controlTask("cancel")}
              >
                <CircleStop size={17} />
              </IconButton>
            ) : null}
            <button
              className="composer__send"
              aria-label="发送"
              title="发送"
              onClick={() => void submit()}
              disabled={!value.trim() || sending}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

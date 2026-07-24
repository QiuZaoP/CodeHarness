import { Bot, UserRound } from "lucide-react";
import { useEffect, useRef } from "react";
import { useWorkspace } from "../state/WorkspaceContext";
import { Composer } from "./Composer";
import { TaskProgress } from "./TaskProgress";

export function ConversationPane() {
  const { snapshot } = useWorkspace();
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeMessages = snapshot
    ? snapshot.messages[snapshot.activeSessionId] || []
    : [];

  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [activeMessages.length]);

  if (!snapshot) {
    return null;
  }

  const activeSession = snapshot.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  );

  return (
    <main className="conversation-pane">
      <header className="conversation-header">
        <div className="conversation-header__title">
          <h1>{activeSession?.title || "新任务"}</h1>
          <span>{snapshot.task.status === "PAUSED" ? "已暂停" : "工作区任务"}</span>
        </div>
      </header>

      <div className="conversation-scroll" ref={scrollRef}>
        <div className="conversation-content">
          {activeMessages.length === 0 ? (
            <section className="empty-conversation">
              <Bot size={28} />
              <h2>从代码库开始</h2>
              <p>描述目标，CodeHarness 会先检查工作区，再规划和执行任务。</p>
            </section>
          ) : (
            activeMessages.map((message) => (
              <article
                key={message.id}
                className={`message message--${message.role}`}
              >
                <div className="message__avatar">
                  {message.role === "user" ? (
                    <UserRound size={16} />
                  ) : (
                    <Bot size={16} />
                  )}
                </div>
                <div className="message__body">
                  <div className="message__meta">
                    <strong>
                      {message.role === "user" ? "你" : "CodeHarness"}
                    </strong>
                    <time>{message.createdAt}</time>
                  </div>
                  <p>{message.content}</p>
                </div>
              </article>
            ))
          )}
          {snapshot.activeSessionId === "session-login" ? (
            <TaskProgress />
          ) : null}
        </div>
      </div>
      <Composer />
    </main>
  );
}

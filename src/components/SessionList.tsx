import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleEllipsis,
  MessageSquarePlus,
} from "lucide-react";
import { useWorkspace } from "../state/WorkspaceContext";
import type { Session } from "../types";
import { IconButton } from "./IconButton";

const statusIcon = (session: Session) => {
  if (session.status === "running") {
    return <CircleDashed className="spin-slow" size={14} />;
  }
  if (session.status === "completed") {
    return <CircleCheck size={14} />;
  }
  if (session.status === "cancelled") {
    return <Ban size={14} />;
  }
  return <CircleEllipsis size={14} />;
};

export function SessionList() {
  const { snapshot, selectSession, createSession } = useWorkspace();

  if (!snapshot) {
    return null;
  }

  return (
    <div className="session-pane">
      <div className="session-pane__header">
        <span>任务</span>
        <div className="session-pane__actions">
          <IconButton label="新建任务" size="small" onClick={createSession}>
            <MessageSquarePlus size={17} />
          </IconButton>
        </div>
      </div>
      <div className="session-list">
        {snapshot.sessions.map((session) => (
          <button
            key={session.id}
            className={`session-item ${
              session.id === snapshot.activeSessionId
                ? "session-item--active"
                : ""
            }`}
            onClick={() => selectSession(session.id)}
          >
            <span className={`session-item__status status-${session.status}`}>
              {statusIcon(session)}
            </span>
            <span className="session-item__content">
              <span className="session-item__title-row">
                <strong>{session.title}</strong>
                <small>{session.updatedAt}</small>
              </span>
              <span className="session-item__preview">{session.preview}</span>
            </span>
            {session.unread ? (
              <span className="session-item__unread" aria-label="未读" />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

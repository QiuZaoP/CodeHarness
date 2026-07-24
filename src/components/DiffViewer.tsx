import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  FileDiff,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "../state/WorkspaceContext";
import type { FileChange } from "../types";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";

function decisionLabel(decision: FileChange["decision"]) {
  if (decision === "accepted") {
    return "已接受";
  }
  if (decision === "rejected") {
    return "已拒绝";
  }
  return "待审阅";
}

export function DiffViewer() {
  const { snapshot, decideChange, rollbackTask } = useWorkspace();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [bulkDecision, setBulkDecision] = useState<
    FileChange["decision"] | null
  >(null);
  const [confirmRollback, setConfirmRollback] = useState(false);

  if (!snapshot) {
    return null;
  }

  const pending = snapshot.changes.filter(
    (change) => change.decision === "pending",
  );
  const additions = snapshot.changes.reduce(
    (total, change) => total + change.additions,
    0,
  );
  const deletions = snapshot.changes.reduce(
    (total, change) => total + change.deletions,
    0,
  );

  const decideAll = async (decision: FileChange["decision"]) => {
    await Promise.all(
      pending.map((change) => decideChange(change.id, decision)),
    );
  };

  const toggleCollapsed = (changeId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(changeId)) {
        next.delete(changeId);
      } else {
        next.add(changeId);
      }
      return next;
    });
  };

  return (
    <div className="diff-viewer">
      <header className="diff-summary">
        <div>
          <strong>{snapshot.changes.length} 个文件已更改</strong>
          <span className="diff-stat diff-stat--add">+{additions}</span>
          <span className="diff-stat diff-stat--remove">-{deletions}</span>
        </div>
        <div className="diff-summary__actions">
          <button
            className="button button--secondary button--compact"
            onClick={() => setConfirmRollback(true)}
          >
            <RotateCcw size={14} />
            回滚任务
          </button>
          <button
            className="button button--secondary button--compact"
            onClick={() => setBulkDecision("rejected")}
            disabled={pending.length === 0}
          >
            <XCircle size={14} />
            全部拒绝
          </button>
          <button
            className="button button--primary button--compact"
            onClick={() => setBulkDecision("accepted")}
            disabled={pending.length === 0}
          >
            <CheckCheck size={14} />
            全部接受
          </button>
        </div>
      </header>

      <div className="diff-files">
        {snapshot.changes.map((change) => {
          const isCollapsed = collapsed.has(change.id);
          return (
            <section
              className={`diff-file diff-file--${change.decision}`}
              key={change.id}
            >
              <header className="diff-file__header">
                <button
                  className="diff-file__toggle"
                  onClick={() => toggleCollapsed(change.id)}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? (
                    <ChevronRight size={15} />
                  ) : (
                    <ChevronDown size={15} />
                  )}
                  <FileDiff size={15} />
                  <strong>{change.path}</strong>
                </button>
                <div className="diff-file__controls">
                  <span
                    className={`diff-decision diff-decision--${change.decision}`}
                  >
                    {decisionLabel(change.decision)}
                  </span>
                  {change.decision === "pending" ? (
                    <>
                      <IconButton
                        label={`拒绝 ${change.path}`}
                        size="small"
                        onClick={() => void decideChange(change.id, "rejected")}
                      >
                        <X size={14} />
                      </IconButton>
                      <IconButton
                        label={`接受 ${change.path}`}
                        size="small"
                        className="icon-button--positive"
                        onClick={() => void decideChange(change.id, "accepted")}
                      >
                        <Check size={14} />
                      </IconButton>
                    </>
                  ) : (
                    <IconButton
                      label={`撤销 ${change.path} 的决定`}
                      size="small"
                      onClick={() => void decideChange(change.id, "pending")}
                    >
                      <RotateCcw size={14} />
                    </IconButton>
                  )}
                </div>
              </header>

              {!isCollapsed ? (
                <div className="diff-code-scroll">
                  {change.hunks.map((hunk) => (
                    <div className="diff-hunk" key={hunk.id}>
                      <div className="diff-hunk__header">{hunk.header}</div>
                      <table className="diff-table">
                        <tbody>
                          {hunk.lines.map((line, index) => (
                            <tr
                              className={`diff-line diff-line--${line.kind}`}
                              key={`${line.text}-${index}`}
                            >
                              <td>{line.oldNumber || ""}</td>
                              <td>{line.newNumber || ""}</td>
                              <td className="diff-line__mark">
                                {line.kind === "add"
                                  ? "+"
                                  : line.kind === "remove"
                                    ? "-"
                                    : " "}
                              </td>
                              <td>
                                <code>{line.text || " "}</code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <Modal
        open={bulkDecision !== null}
        title={bulkDecision === "accepted" ? "接受全部变更" : "拒绝全部变更"}
        description={`将处理 ${pending.length} 个待审阅文件。`}
        onClose={() => setBulkDecision(null)}
        footer={
          <>
            <button
              className="button button--secondary"
              onClick={() => setBulkDecision(null)}
            >
              取消
            </button>
            <button
              className={
                bulkDecision === "accepted"
                  ? "button button--primary"
                  : "button button--danger"
              }
              onClick={() => {
                if (bulkDecision) {
                  void decideAll(bulkDecision);
                }
                setBulkDecision(null);
              }}
            >
              确认{bulkDecision === "accepted" ? "接受" : "拒绝"}
            </button>
          </>
        }
      >
        <p className="confirmation-copy">
          {bulkDecision === "accepted"
            ? "接受后这些文件将进入可应用状态。"
            : "拒绝后这些变更不会进入最终结果，仍可逐文件撤销决定。"}
        </p>
      </Modal>
      <Modal
        open={confirmRollback}
        title="回滚本次任务"
        description="工作区将恢复到任务开始时的快照。"
        onClose={() => setConfirmRollback(false)}
        footer={
          <>
            <button
              className="button button--secondary"
              onClick={() => setConfirmRollback(false)}
            >
              保留变更
            </button>
            <button
              className="button button--danger"
              onClick={() => {
                void rollbackTask();
                setConfirmRollback(false);
              }}
            >
              确认回滚
            </button>
          </>
        }
      >
        <p className="confirmation-copy">
          当前任务的文件修改会被撤销，任务记录和工具日志仍会保留。
        </p>
      </Modal>
    </div>
  );
}

import {
  Ban,
  Check,
  Circle,
  CircleDashed,
  Clock3,
  Pause,
  Play,
  RotateCcw,
  TerminalSquare,
  X
} from 'lucide-react';
import { useState } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ToolCallStatus } from '../types';
import { IconButton } from './IconButton';
import { Modal } from './Modal';

const statusIcon = (status: ToolCallStatus) => {
  if (status === 'completed') {
    return <Check size={13} />;
  }
  if (status === 'running') {
    return <CircleDashed size={13} className="spin-slow" />;
  }
  if (status === 'failed') {
    return <X size={13} />;
  }
  return <Circle size={13} />;
};

export function TaskProgress() {
  const { snapshot, controlTask } = useWorkspace();
  const [expandedTool, setExpandedTool] = useState<string | null>('tool-4');
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (!snapshot) {
    return null;
  }

  const { task } = snapshot;
  const isPaused = task.status === 'PAUSED';
  const isCancelled = task.status === 'CANCELLED';
  const isFailed = task.status === 'FAILED';
  const isReviewReady = task.status === 'READY_FOR_REVIEW';
  const isWaitingUser = task.status === 'WAITING_USER';
  const isApplied = task.status === 'APPLIED';
  const controlsDisabled = isCancelled || isFailed || isReviewReady || isApplied;
  const statusLabel =
    task.status === 'PAUSED'
      ? '已暂停'
      : isWaitingUser
        ? '等待确认'
        : isApplied
          ? '已应用'
          : task.status === 'CANCELLED'
            ? '已取消'
            : task.status === 'FAILED'
              ? '执行失败'
              : task.status === 'READY_FOR_REVIEW'
                ? '等待审阅'
                : task.status === 'VERIFYING'
                  ? '正在验证'
                  : '正在执行';

  return (
    <section className="task-progress" aria-label="任务进度">
      <header className="task-progress__header">
        <div className="task-progress__status">
          <span className={`run-status run-status--${task.status.toLocaleLowerCase()}`}>
            {isPaused ? (
              <Pause size={13} />
            ) : isCancelled || isFailed ? (
              <Ban size={13} />
            ) : isReviewReady || isApplied ? (
              <Check size={13} />
            ) : (
              <CircleDashed size={13} className="spin-slow" />
            )}
            {statusLabel}
          </span>
          <span className="task-progress__meta">
            <Clock3 size={13} />
            {task.elapsed}
          </span>
          <span className="task-progress__model">{task.model}</span>
        </div>
        <div className="task-progress__controls">
          <IconButton
            label={isPaused ? '继续任务' : '暂停任务'}
            size="small"
            onClick={() => controlTask(isPaused ? 'resume' : 'pause')}
            disabled={controlsDisabled}
          >
            {isPaused ? <Play size={15} /> : <Pause size={15} />}
          </IconButton>
          <IconButton
            label="取消任务"
            size="small"
            onClick={() => setConfirmCancel(true)}
            disabled={controlsDisabled}
          >
            <X size={15} />
          </IconButton>
        </div>
      </header>

      <div className="task-progress__body">
        <div className="plan-steps">
          {task.steps.map((step) => (
            <div className={`plan-step plan-step--${step.status}`} key={step.id}>
              <span className="plan-step__marker">
                {step.status === 'completed' ? (
                  <Check size={12} />
                ) : step.status === 'active' ? (
                  <CircleDashed size={12} className="spin-slow" />
                ) : (
                  <Circle size={10} />
                )}
              </span>
              <span>{step.label}</span>
            </div>
          ))}
        </div>

        <div className="tool-log">
          <div className="tool-log__title">
            <TerminalSquare size={14} />
            工具活动
          </div>
          {task.toolCalls.map((tool) => (
            <button
              key={tool.id}
              className={`tool-call tool-call--${tool.status}`}
              onClick={() => setExpandedTool((current) => (current === tool.id ? null : tool.id))}
              aria-expanded={expandedTool === tool.id}
            >
              <span className="tool-call__status">{statusIcon(tool.status)}</span>
              <span className="tool-call__content">
                <span className="tool-call__summary">
                  <code>{tool.name}</code>
                  <span>{tool.summary}</span>
                  {tool.duration ? <small>{tool.duration}</small> : null}
                </span>
                {expandedTool === tool.id ? (
                  <span className="tool-call__detail">{tool.detail}</span>
                ) : null}
              </span>
            </button>
          ))}
          {isPaused ? (
            <div className="task-callout">
              <RotateCcw size={14} />
              任务状态已保留，继续后将从当前步骤恢复。
            </div>
          ) : null}
          {isFailed ? (
            <div className="task-callout task-callout--error">
              <X size={14} />
              任务执行失败，请检查工具日志后重新发送任务。
            </div>
          ) : null}
        </div>
      </div>
      <Modal
        open={confirmCancel}
        title="取消当前任务"
        description="当前执行会停止，已有变更和审计记录仍会保留。"
        onClose={() => setConfirmCancel(false)}
        footer={
          <>
            <button className="button button--secondary" onClick={() => setConfirmCancel(false)}>
              继续执行
            </button>
            <button
              className="button button--danger"
              onClick={() => {
                void controlTask('cancel');
                setConfirmCancel(false);
              }}
            >
              取消任务
            </button>
          </>
        }
      >
        <p className="confirmation-copy">
          取消后可以继续查看和审阅当前 Diff，但任务不会再调用工具。
        </p>
      </Modal>
    </section>
  );
}

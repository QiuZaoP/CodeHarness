import { Braces, Copy, FileCode2, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import { IconButton } from './IconButton';

function tokenizeLine(line: string) {
  const pattern =
    /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:import|from|export|async|function|const|let|return|if|throw|new|await|type|interface)\b|\b\d+\b|\/\/.*$)/g;
  const parts = line.split(pattern).filter((part) => part !== '');

  return parts.map((part, index) => {
    let className = '';
    if (/^["'`]/.test(part)) {
      className = 'token-string';
    } else if (
      /^(import|from|export|async|function|const|let|return|if|throw|new|await|type|interface)$/.test(
        part
      )
    ) {
      className = 'token-keyword';
    } else if (/^\d+$/.test(part)) {
      className = 'token-number';
    } else if (/^\/\//.test(part)) {
      className = 'token-comment';
    }
    return (
      <span className={className} key={`${part}-${index}`}>
        {part}
      </span>
    );
  });
}

export function CodeViewer() {
  const { snapshot, activeFileLine, openFile, closeFile } = useWorkspace();
  const activeLineRef = useRef<HTMLTableRowElement>(null);
  const activeFile = snapshot?.files[snapshot.activeFilePath];
  const lines = useMemo(
    () => activeFile?.content.replace(/\n$/, '').split('\n') || [],
    [activeFile]
  );

  useEffect(() => {
    activeLineRef.current?.scrollIntoView?.({
      block: 'center',
      inline: 'nearest'
    });
  }, [activeFile?.path, activeFileLine]);

  if (!snapshot || !activeFile) {
    return (
      <div className="code-empty">
        <Braces size={28} />
        <span>选择文件以查看代码</span>
      </div>
    );
  }

  return (
    <div className="code-viewer">
      <div className="editor-tabs" role="tablist">
        {snapshot.openFilePaths.map((path) => {
          const name = path.split('/').pop();
          return (
            <div
              key={path}
              className={`editor-tab ${
                snapshot.activeFilePath === path ? 'editor-tab--active' : ''
              }`}
            >
              <button
                className="editor-tab__select"
                onClick={() => void openFile(path)}
                role="tab"
                aria-selected={snapshot.activeFilePath === path}
              >
                <FileCode2 size={14} />
                <span>{name}</span>
              </button>
              {snapshot.openFilePaths.length > 1 ? (
                <IconButton
                  label={`关闭 ${name}`}
                  className="editor-tab__close"
                  size="small"
                  onClick={() => closeFile(path)}
                >
                  <X size={13} />
                </IconButton>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="editor-breadcrumbs">
        <span>{activeFile.path.replace(/\//g, '  /  ')}</span>
        <IconButton
          label="复制文件内容"
          size="small"
          onClick={() => void navigator.clipboard?.writeText(activeFile.content)}
        >
          <Copy size={14} />
        </IconButton>
      </div>
      <div className="code-scroll">
        <table className="code-table">
          <tbody>
            {lines.map((line, index) => (
              <tr
                key={`${line}-${index}`}
                ref={activeFileLine === index + 1 ? activeLineRef : undefined}
                className={activeFileLine === index + 1 ? 'code-row--highlighted' : ''}
              >
                <td className="code-line-number">{index + 1}</td>
                <td className="code-line">
                  <code>{tokenizeLine(line)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

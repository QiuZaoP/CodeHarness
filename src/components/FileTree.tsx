import {
  Braces,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import type { FileNode } from '../types';

function FileTypeIcon({ node }: { node: FileNode }) {
  if (node.type === 'folder') {
    return <Folder size={15} />;
  }
  if (node.name.endsWith('.json')) {
    return <FileJson size={15} />;
  }
  if (node.name.endsWith('.md')) {
    return <FileText size={15} />;
  }
  if (node.name.endsWith('.ts') || node.name.endsWith('.tsx')) {
    return <FileCode2 size={15} />;
  }
  if (node.name.endsWith('.css')) {
    return <Braces size={15} />;
  }
  return <File size={15} />;
}

function TreeNode({
  node,
  depth,
  expanded,
  toggleExpanded,
  activePath,
  onOpen
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  toggleExpanded: (path: string) => void;
  activePath: string;
  onOpen: (path: string) => void;
}) {
  const isExpanded = expanded.has(node.path);
  const isFolder = node.type === 'folder';

  return (
    <>
      <button
        className={`tree-row ${node.path === activePath ? 'tree-row--active' : ''}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        onClick={() => (isFolder ? toggleExpanded(node.path) : onOpen(node.path))}
      >
        <span className="tree-row__chevron">
          {isFolder ? isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </span>
        <span className={`tree-row__icon ${isFolder && isExpanded ? 'is-open' : ''}`}>
          {isFolder && isExpanded ? <FolderOpen size={15} /> : <FileTypeIcon node={node} />}
        </span>
        <span className="tree-row__name">{node.name}</span>
        {node.status ? (
          <span className={`tree-row__status status-${node.status}`}>
            {node.status === 'modified' ? 'M' : node.status === 'added' ? 'A' : 'D'}
          </span>
        ) : null}
      </button>
      {isFolder && isExpanded
        ? node.children?.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              activePath={activePath}
              onOpen={onOpen}
            />
          ))
        : null}
    </>
  );
}

export function FileTree() {
  const { snapshot, openFile } = useWorkspace();
  const initialExpanded = useMemo(
    () => new Set(['src', 'src/api', 'src/app', 'src/harness', 'tests']),
    []
  );
  const [expanded, setExpanded] = useState(initialExpanded);

  if (!snapshot) {
    return null;
  }

  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="file-pane">
      <div className="file-pane__header">
        <span>资源管理器</span>
        <small>{snapshot.fileTree.length} 个根项目</small>
      </div>
      <div className="file-tree">
        {snapshot.fileTree.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            activePath={snapshot.activeFilePath}
            onOpen={openFile}
          />
        ))}
      </div>
    </div>
  );
}

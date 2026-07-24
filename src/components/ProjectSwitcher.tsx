import { Check, ChevronDown, FolderGit2, FolderPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../state/WorkspaceContext";
import { Modal } from "./Modal";

export function ProjectSwitcher() {
  const {
    snapshot,
    importProject,
    selectProject,
  } = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [path, setPath] = useState("C:/Users/demo/projects/");
  const [submitting, setSubmitting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  if (!snapshot) {
    return null;
  }

  const activeProject =
    snapshot.projects.find(
      (project) => project.id === snapshot.activeProjectId,
    ) || snapshot.projects[0];

  const submitImport = async () => {
    if (!path.trim()) {
      return;
    }
    setSubmitting(true);
    try {
      await importProject(path.trim());
      setModalOpen(false);
      setMenuOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="project-switcher" ref={rootRef}>
        <button
          className="project-switcher__trigger"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <span className="project-switcher__icon">
            <FolderGit2 size={17} />
          </span>
          <span className="project-switcher__copy">
            <strong>{activeProject.name}</strong>
            <small>{activeProject.branch}</small>
          </span>
          <ChevronDown size={15} />
        </button>

        {menuOpen ? (
          <div className="project-menu" role="menu">
            <div className="project-menu__label">项目</div>
            {snapshot.projects.map((project) => (
              <button
                className="project-menu__item"
                key={project.id}
                role="menuitem"
                onClick={() => {
                  selectProject(project.id);
                  setMenuOpen(false);
                }}
              >
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </span>
                {project.id === snapshot.activeProjectId ? (
                  <Check size={16} />
                ) : null}
              </button>
            ))}
            <button
              className="project-menu__import"
              role="menuitem"
              onClick={() => setModalOpen(true)}
            >
              <FolderPlus size={16} />
              导入本地项目
            </button>
          </div>
        ) : null}
      </div>

      <Modal
        open={modalOpen}
        title="导入本地项目"
        description="项目将作为独立工作区加入列表。"
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <button
              className="button button--secondary"
              onClick={() => setModalOpen(false)}
            >
              取消
            </button>
            <button
              className="button button--primary"
              onClick={submitImport}
              disabled={submitting || !path.trim()}
            >
              {submitting ? "正在导入" : "导入项目"}
            </button>
          </>
        }
      >
        <label className="field">
          <span>项目路径</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            autoFocus
            placeholder="C:/Users/name/projects/repository"
          />
        </label>
      </Modal>
    </>
  );
}

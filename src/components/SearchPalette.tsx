import { FileCode2, Search, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import { IconButton } from './IconButton';

export function SearchPalette() {
  const {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchResults,
    runSearch,
    openFile
  } = useWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (searchOpen) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [searchOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [searchQuery, searchResults.length]);

  if (!searchOpen) {
    return null;
  }

  const openActiveResult = () => {
    const result = searchResults[activeIndex];
    if (result) {
      openFile(result.path, result.line);
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) =>
        searchResults.length ? (current + 1) % searchResults.length : 0
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) =>
        searchResults.length ? (current - 1 + searchResults.length) % searchResults.length : 0
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openActiveResult();
    }
  };

  return (
    <div className="search-backdrop" role="presentation" onMouseDown={() => setSearchOpen(false)}>
      <section
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="代码搜索"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-palette__input">
          <Search size={18} />
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              void runSearch(event.target.value);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="搜索文件、符号或代码"
          />
          <IconButton label="关闭搜索" size="small" onClick={() => setSearchOpen(false)}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="search-results">
          {!searchQuery ? (
            <div className="search-empty">输入关键词开始搜索</div>
          ) : searchResults.length === 0 ? (
            <div className="search-empty">没有找到匹配内容</div>
          ) : (
            searchResults.map((result, index) => (
              <button
                className={`search-result ${activeIndex === index ? 'search-result--active' : ''}`}
                key={`${result.path}-${result.line}-${result.preview}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openFile(result.path, result.line)}
                aria-selected={activeIndex === index}
              >
                <FileCode2 size={15} />
                <span>
                  <strong>{result.path}</strong>
                  <small>
                    第 {result.line} 行 · {result.preview}
                  </small>
                </span>
              </button>
            ))
          )}
        </div>
        <footer className="search-palette__footer">
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </footer>
      </section>
    </div>
  );
}

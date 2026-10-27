'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';

/** 宽表格在窄屏里横向滚动，并给出视觉提示（键盘也能滚动） */
export function GuideTable(props: ComponentProps<'table'>) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const update = () => setScrollable(node.scrollWidth > node.clientWidth + 1);
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const table = node.querySelector('table');
    if (table) observer.observe(table);
    update();
    return () => observer.disconnect();
  }, []);

  return (
    <div className="guide-table">
      {scrollable && <p className="guide-table-hint">左右滑动查看更多列</p>}
      <div
        ref={viewport}
        className="relative overflow-auto prose-no-margin"
        tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? 'region' : undefined}
        aria-label={scrollable ? '可横向滚动的表格' : undefined}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !scrollable) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.currentTarget.scrollLeft += event.key === 'ArrowRight' ? 80 : -80;
          }
        }}
      >
        <table {...props} />
      </div>
    </div>
  );
}
import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Loading } from './Empty.tsx';

export interface Column<T> {
  key: string;
  title: ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  render: (row: T, index: number) => ReactNode;
  /** 关掉这一列的点表头排序 */
  sortable?: boolean;
  /** 自定义排序取值，默认取 row[key] */
  sortValue?: (row: T) => string | number | null | undefined;
}

export type SortDir = 'asc' | 'desc';

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  empty?: ReactNode;
  rowClassName?: (row: T) => string;
  renderExpanded?: (row: T) => ReactNode;
  /** 每页条数，不传就不分页 */
  pageSize?: number;
  /** 开启多选，配合 selectedKeys / onSelectionChange 使用 */
  selectable?: boolean;
  selectedKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  /** 初始排序 */
  defaultSort?: { key: string; dir: SortDir };
}

function sortKeyOf<T>(col: Column<T>, row: T): string | number | null {
  if (col.sortValue) {
    const v = col.sortValue(row);
    return v === undefined || v === null ? null : v;
  }
  const v = (row as Record<string, unknown>)[col.key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  rowClassName,
  renderExpanded,
  pageSize,
  selectable,
  selectedKeys,
  onSelectionChange,
  defaultSort,
}: DataTableProps<T>) {
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<string>(defaultSort?.key ?? '');
  const [sortDir, setSortDir] = useState<SortDir>(defaultSort?.dir ?? 'asc');

  const sortCol = sortKey ? columns.find((col) => col.key === sortKey) : undefined;

  const sorted = sortCol
    ? [...rows].sort((a, b) => {
        const av = sortKeyOf(sortCol, a);
        const bv = sortKeyOf(sortCol, b);
        // 空值一律沉底，不随方向翻转
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        let cmp: number;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv), 'zh-Hans-CN', { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : rows;

  const paged = typeof pageSize === 'number' && pageSize > 0;
  const size = paged ? pageSize : sorted.length;
  const pageCount = paged ? Math.max(1, Math.ceil(sorted.length / size)) : 1;

  // 数据变少（筛选/删除）时把页码拉回有效范围
  useEffect(() => {
    setPage((prev) => (prev > pageCount - 1 ? pageCount - 1 : prev));
  }, [pageCount]);

  const visible = paged ? sorted.slice(page * size, page * size + size) : sorted;

  const toggleSort = (col: Column<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
    setPage(0);
  };

  const toggle = (key: string) => {
    setOpenKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const selected = selectedKeys ?? [];
  const pageKeys = visible.map((row, index) => rowKey(row, index));
  const allChecked = selectable && pageKeys.length > 0 && pageKeys.every((k) => selected.includes(k));
  const someChecked = selectable && !allChecked && pageKeys.some((k) => selected.includes(k));

  const toggleRow = (key: string) => {
    if (!onSelectionChange) return;
    onSelectionChange(
      selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key],
    );
  };

  const togglePage = () => {
    if (!onSelectionChange) return;
    if (allChecked) {
      onSelectionChange(selected.filter((key) => !pageKeys.includes(key)));
    } else {
      const next = new Set(selected);
      for (const key of pageKeys) next.add(key);
      onSelectionChange([...next]);
    }
  };

  const colSpan = columns.length + (renderExpanded ? 1 : 0) + (selectable ? 1 : 0);

  return (
    <div className="table-block">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {selectable ? (
                <th className="select-col">
                  <input
                    type="checkbox"
                    aria-label="全选本页"
                    checked={Boolean(allChecked)}
                    ref={(node) => {
                      if (node) node.indeterminate = Boolean(someChecked);
                    }}
                    onChange={togglePage}
                  />
                </th>
              ) : null}
              {renderExpanded ? <th className="expander-col" aria-label="展开" /> : null}
              {columns.map((col) => {
                const active = sortKey === col.key;
                const canSort = col.sortable !== false;
                return (
                  <th
                    key={col.key}
                    style={col.width ? { width: col.width } : undefined}
                    className={`${col.align ? `align-${col.align}` : ''}${col.className ? ` ${col.className}` : ''}${
                      active ? ' is-sorted' : ''
                    }`}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => toggleSort(col)}
                        title={active && sortDir === 'asc' ? '点一下改成降序' : '点一下按这列排序'}
                      >
                        <span>{col.title}</span>
                        <span className="sort-caret">{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                      </button>
                    ) : (
                      col.title
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td className="table-state" colSpan={colSpan}>
                  <Loading />
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td className="table-state" colSpan={colSpan}>
                  {empty ?? <div className="table-empty">暂无数据</div>}
                </td>
              </tr>
            ) : (
              visible.map((row, index) => {
                const key = rowKey(row, index);
                const expanded = openKeys.includes(key);
                return (
                  <Fragment key={key}>
                    <tr
                      className={`${rowClassName ? rowClassName(row) : ''}${expanded ? ' is-open' : ''}${
                        selectable && selected.includes(key) ? ' is-selected' : ''
                      }`}
                    >
                      {selectable ? (
                        <td className="select-col">
                          <input
                            type="checkbox"
                            aria-label="选择这一行"
                            checked={selected.includes(key)}
                            onChange={() => toggleRow(key)}
                          />
                        </td>
                      ) : null}
                      {renderExpanded ? (
                        <td className="expander-col">
                          <button
                            type="button"
                            className="expander"
                            aria-label={expanded ? '收起' : '展开'}
                            onClick={() => toggle(key)}
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                        </td>
                      ) : null}
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={`${col.align ? `align-${col.align}` : ''}${col.className ? ` ${col.className}` : ''}`}
                        >
                          {col.render(row, index)}
                        </td>
                      ))}
                    </tr>
                    {expanded && renderExpanded ? (
                      <tr className="expanded-row">
                        <td colSpan={colSpan}>{renderExpanded(row)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {paged && sorted.length > size ? (
        <div className="table-pager">
          <span className="dim small">
            共 {sorted.length} 条 · 第 {page + 1}/{pageCount} 页
            {sortCol ? ` · 按${typeof sortCol.title === 'string' ? sortCol.title : sortCol.key}${sortDir === 'asc' ? '升序' : '降序'}` : ''}
          </span>
          <div className="table-pager-actions">
            <button
              type="button"
              className="btn sm ghost"
              disabled={page === 0}
              onClick={() => setPage(0)}
            >
              首页
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={page === 0}
              onClick={() => setPage((prev) => Math.max(0, prev - 1))}
            >
              上一页
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((prev) => Math.min(pageCount - 1, prev + 1))}
            >
              下一页
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(pageCount - 1)}
            >
              末页
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Loading } from './Empty.tsx';

export interface Column<T> {
  key: string;
  title: ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  render: (row: T, index: number) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  empty?: ReactNode;
  rowClassName?: (row: T) => string;
  renderExpanded?: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  rowClassName,
  renderExpanded,
}: DataTableProps<T>) {
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  const toggle = (key: string) => {
    setOpenKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {renderExpanded ? <th className="expander-col" aria-label="展开" /> : null}
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={`${col.align ? `align-${col.align}` : ''}${col.className ? ` ${col.className}` : ''}`}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <tr>
              <td
                className="table-state"
                colSpan={columns.length + (renderExpanded ? 1 : 0)}
              >
                <Loading />
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td
                className="table-state"
                colSpan={columns.length + (renderExpanded ? 1 : 0)}
              >
                {empty ?? <div className="table-empty">暂无数据</div>}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const key = rowKey(row, index);
              const expanded = openKeys.includes(key);
              return (
                <Fragment key={key}>
                  <tr className={`${rowClassName ? rowClassName(row) : ''}${expanded ? ' is-open' : ''}`}>
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
                      <td colSpan={columns.length + 1}>{renderExpanded(row)}</td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Search, Download, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, FileSpreadsheet, FileText, FileDown } from 'lucide-react';
import { Loading, ErrorState, Empty } from './DataStates';
import { exportExcel, exportCSV, exportPDF, ExportColumn } from '../lib/exporters';
import './DataTable.scss';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;        // custom cell display
  value?: (row: T) => string | number;          // plain value for sort/search/export
  sortable?: boolean;                            // default true
  align?: 'left' | 'right' | 'center';
}

export interface RowAction<T> {
  icon: React.ReactNode;
  label: string;
  onClick: (row: T) => void;
  show?: (row: T) => boolean;
  variant?: 'default' | 'danger';
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | null;
  getRowKey: (row: T) => string | number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  searchKeys?: ((row: T) => string)[];
  searchPlaceholder?: string;
  rowActions?: RowAction<T>[];
  exportName?: string;
  exportTitle?: string;
  pageSize?: number;
  emptyMessage?: string;
  toolbarExtra?: React.ReactNode;
}

const val = <T,>(col: Column<T>, row: T): any => (col.value ? col.value(row) : (row as any)[col.key]);

export default function DataTable<T>({
  columns, rows, getRowKey, loading, error, onRetry,
  searchKeys, searchPlaceholder = 'Search…', rowActions, exportName, exportTitle,
  pageSize = 15, emptyMessage = 'Nothing here yet.', toolbarExtra,
}: Props<T>) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => { setPage(1); }, [search]);

  const filtered = useMemo(() => {
    let list = rows ?? [];
    if (search && searchKeys?.length) {
      const q = search.toLowerCase();
      list = list.filter(r => searchKeys.some(fn => (fn(r) ?? '').toLowerCase().includes(q)));
    }
    if (sortKey) {
      const col = columns.find(c => c.key === sortKey);
      if (col) {
        list = [...list].sort((a, b) => {
          const av = val(col, a), bv = val(col, b);
          if (av == null) return 1;
          if (bv == null) return -1;
          const cmp = typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv), undefined, { numeric: true });
          return sortDir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return list;
  }, [rows, search, searchKeys, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (col: Column<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(col.key); setSortDir('asc'); }
  };

  const doExport = (fmt: 'xlsx' | 'csv' | 'pdf') => {
    setExportOpen(false);
    const cols: ExportColumn<T>[] = columns.map(c => ({ header: c.header, value: (r: T) => val(c, r) ?? '' }));
    const name = exportName ?? 'export';
    if (fmt === 'xlsx') exportExcel(cols, filtered, name);
    else if (fmt === 'csv') exportCSV(cols, filtered, name);
    else exportPDF(cols, filtered, name, exportTitle ?? name);
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  return (
    <div className="data-table">
      <div className="dt-toolbar">
        {searchKeys?.length ? (
          <div className="dt-search">
            <Search size={15} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={searchPlaceholder} />
          </div>
        ) : <div />}
        <div className="dt-toolbar-right">
          {toolbarExtra}
          {exportName && (rows?.length ?? 0) > 0 && (
            <div className="dt-export" ref={exportRef}>
              <button className="btn-secondary btn-sm" onClick={() => setExportOpen(o => !o)}>
                <Download size={14} /> Export
              </button>
              {exportOpen && (
                <div className="dt-export-menu">
                  <button onClick={() => doExport('xlsx')}><FileSpreadsheet size={14} /> Excel (.xlsx)</button>
                  <button onClick={() => doExport('csv')}><FileText size={14} /> CSV (.csv)</button>
                  <button onClick={() => doExport('pdf')}><FileDown size={14} /> PDF (.pdf)</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty message={search ? 'No matches for your search.' : emptyMessage} />
      ) : (
        <>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  {columns.map(col => (
                    <th key={col.key}
                      className={`${col.sortable === false ? '' : 'sortable'} ${col.align ? 'align-' + col.align : ''}`}
                      onClick={() => toggleSort(col)}>
                      <span className="th-inner">
                        {col.header}
                        {sortKey === col.key && (sortDir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
                      </span>
                    </th>
                  ))}
                  {rowActions?.length ? <th className="align-right">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {pageRows.map(row => (
                  <tr key={getRowKey(row)}>
                    {columns.map(col => (
                      <td key={col.key} className={col.align ? 'align-' + col.align : ''}>
                        {col.render ? col.render(row) : String(val(col, row) ?? '—')}
                      </td>
                    ))}
                    {rowActions?.length ? (
                      <td className="align-right dt-actions">
                        {rowActions.filter(a => !a.show || a.show(row)).map((a, i) => (
                          <button key={i} className={`dt-action ${a.variant === 'danger' ? 'danger' : ''}`}
                            title={a.label} onClick={() => a.onClick(row)}>
                            {a.icon}
                          </button>
                        ))}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="dt-footer">
            <span className="dt-count">
              {filtered.length} record{filtered.length !== 1 ? 's' : ''}
              {filtered.length > pageSize && ` · page ${page} of ${totalPages}`}
            </span>
            {totalPages > 1 && (
              <div className="dt-pager">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={15} /></button>
                <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={15} /></button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import * as React from 'react';
import {
  VreFSService,
  StorageBackend,
  Dataset,
  DataLakeStatus
} from '../service';
import {
  fairTotal,
  fairColor,
  fairBg,
  BACKEND_LABELS,
  BACKEND_COLORS,
  STATUS_COLORS
} from '../utils';
import { DatasetDetailPanel } from './DatasetDetailPanel';
import { AddStorageWizard } from './AddStorageWizard';

interface Props {
  service: VreFSService;
  fullScreen?: boolean;
  // when set, the panel is in picker mode — selecting a dataset fires this
  // callback with the chosen PID instead of opening the detail view.
  onPickDataset?: (pid: string, name: string) => void;
}

type View = 'catalogue' | 'detail' | 'add-storage' | 'discover';

export const DataLakePanel: React.FC<Props> = ({
  service,
  fullScreen = false,
  onPickDataset
}) => {
  const [backends, setBackends] = React.useState<StorageBackend[]>([]);
  const [datasets, setDatasets] = React.useState<Dataset[]>([]);
  const [status, setStatus] = React.useState<DataLakeStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [view, setView] = React.useState<View>('catalogue');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [filterBackend, setFilter] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [publishLoading, setPublishLoading] = React.useState(false);
  const [backendStatus, setBackendStatus] = React.useState<
    Record<string, 'ok' | 'error' | 'testing'>
  >({});
  const [backendsOpen, setBackendsOpen] = React.useState(true);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [discoverData, setDiscoverData] = React.useState<any[]>([]);
  const [discoverLoading, setDiscoverLoading] = React.useState(false);
  const [discoverError, setDiscoverError] = React.useState<string | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<any[]>([]);
  const [subscribedDatasets, setSubscribedDatasets] = React.useState<Dataset[]>(
    []
  );
  const [importing, setImporting] = React.useState<string | null>(null);

  // Derive which source dataset IDs have already been imported by this researcher.
  // A dataset is imported if the researcher owns a dataset record that lists the
  // source dataset's ID in its source_dataset_ids field.
  const importedSourceIds = React.useMemo(() => {
    const ids = new Set<string>();
    datasets
      .filter(d => !d.source_owner_id)
      .forEach(d => {
        if ((d as any).source_dataset_ids?.length) {
          (d as any).source_dataset_ids.forEach((id: string) => ids.add(id));
        }
      });
    return ids;
  }, [datasets]);

  function toggleDir(path: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderTree(
    nodes: TreeNode[],
    depth: number,
    backend?: StorageBackend
  ): React.ReactNode {
    return nodes.map((node, i) => {
      if (node.type === 'file') {
        const d = node.dataset;
        return (
          <div key={d.id} style={{ paddingLeft: depth * 14 }}>
            <DatasetRow
              dataset={d}
              backend={backend}
              pickerMode={pickerMode}
              onClick={() => {
                if (pickerMode && onPickDataset) {
                  onPickDataset(d.pid ?? `dl:${d.id}`, d.name);
                } else {
                  setSelectedId(d.id);
                  setView('detail');
                }
              }}
            />
          </div>
        );
      } else {
        const isOpen = expanded.has(node.path);
        const fileCount = countFiles(node.children);
        return (
          <div key={node.path}>
            <div
              onClick={() => toggleDir(node.path)}
              style={{
                paddingLeft: depth * 14 + 2,
                padding: `4px 0 4px ${depth * 14 + 2}px`,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                color: 'var(--jp-ui-font-color1)',
                borderBottom: '1px solid var(--jp-border-color2)'
              }}
            >
              <span style={{ fontSize: 9, color: 'var(--jp-ui-font-color2)' }}>
                {isOpen ? '▾' : '▸'}
              </span>
              <span>📁</span>
              <span style={{ flex: 1 }}>{node.name}</span>
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--jp-ui-font-color2)',
                  marginRight: 4
                }}
              >
                {fileCount}
              </span>
            </div>
            {isOpen && renderTree(node.children, depth + 1, backend)}
          </div>
        );
      }
    });
  }

  const pickerMode = !!onPickDataset;

  React.useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [b, d, s, subDatasets] = await Promise.all([
        service.getBackends(),
        service.getDatasets(),
        service.getLakeStatus(),
        service.getSubscribedDatasets().catch(() => [] as Dataset[])
      ]);
      setBackends(b);
      // Merge subscribed datasets — deduplicate by id in case of imports
      const ownIds = new Set(d.map(x => x.id));
      const merged = [...d, ...subDatasets.filter(x => !ownIds.has(x.id))];
      setDatasets(merged);
      setSubscribedDatasets(subDatasets);
      setStatus(s);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load data lake');
    } finally {
      setLoading(false);
    }
  }

  async function testBackend(id: string) {
    setBackendStatus(prev => ({ ...prev, [id]: 'testing' }));
    try {
      const backend = backends.find(b => b.id === id);
      if (backend?.type === 'local') {
        // Local: test reachability AND sync file changes
        const currentFiles = await service.listLocalFiles(backend.root_path);
        setBackendStatus(prev => ({ ...prev, [id]: 'ok' }));

        const existingDatasets = datasets.filter(d => d.backend_id === id);
        const existingPaths = new Set(existingDatasets.map(d => d.path));
        const currentPaths = new Set(currentFiles.map(f => f.path));

        const newFiles = currentFiles.filter(f => !existingPaths.has(f.path));
        const removedDatasets = existingDatasets.filter(
          d => !currentPaths.has(d.path)
        );

        // Register new files
        for (const file of newFiles) {
          try {
            const dataset = await service.createDataset({
              backend: id,
              path: file.path,
              name: file.name
            });
            try {
              const meta = await service.getLocalFileMetadata(file.path);
              await service.patchLocalFileMetadata(dataset.id, {
                format: meta.format,
                size_bytes: meta.size,
                checksum_sha256: meta.checksum_sha256
              });
            } catch {
              /* best-effort */
            }
          } catch {
            /* skip */
          }
        }

        // Remove deleted files
        for (const d of removedDatasets) {
          try {
            await service.deleteDataset(d.id);
          } catch {
            /* skip */
          }
        }

        // Single reload after all changes
        if (newFiles.length > 0 || removedDatasets.length > 0) {
          await loadAll();
        }
      } else {
        // Remote: test connection then re-index
        const result = await service.testBackend(id);
        setBackendStatus(prev => ({
          ...prev,
          [id]: result.ok ? 'ok' : 'error'
        }));
        if (result.ok) {
          try {
            await service.indexRemoteBackend(id);
          } catch {
            /* best-effort */
          }
          await loadAll();
        }
      }
    } catch {
      setBackendStatus(prev => ({ ...prev, [id]: 'error' }));
    }
  }

  async function deleteBackend(id: string) {
    try {
      await service.deleteBackend(id);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? 'Failed to delete backend');
    }
  }

  async function handlePublishToggle() {
    if (!status) {
      return;
    }
    setPublishLoading(true);
    try {
      const updated = await service.publishLake(!status.published);
      setStatus(updated);
    } finally {
      setPublishLoading(false);
    }
  }

  const filtered = datasets.filter(d => {
    const matchBackend =
      filterBackend === 'all' || d.backend_id === filterBackend;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      d.name.toLowerCase().includes(q) ||
      d.tags.some(t => t.toLowerCase().includes(q)) ||
      d.description.toLowerCase().includes(q);
    return matchBackend && matchSearch;
  });

  const avgFair = datasets.length
    ? Math.round(
        datasets.reduce((s, d) => s + fairTotal(d.fair_score), 0) /
          datasets.length
      )
    : 0;

  // --- Loading skeleton ---
  if (loading) {
    return <LoadingSkeleton />;
  }

  // --- Error ---
  if (error) {
    return (
      <div style={{ padding: 16, fontFamily: 'var(--jp-ui-font-family)' }}>
        <div
          style={{
            fontSize: 12,
            color: 'var(--jp-error-color1)',
            marginBottom: 8
          }}
        >
          {error}
        </div>
        <button onClick={loadAll} style={btnSecondary}>
          Retry
        </button>
      </div>
    );
  }

  // --- Add storage wizard ---
  if (view === 'add-storage') {
    return (
      <AddStorageWizard
        service={service}
        onDone={() => {
          loadAll();
          setView('catalogue');
        }}
        onCancel={() => setView('catalogue')}
      />
    );
  }

  // --- Dataset detail ---
  if (view === 'detail' && selectedId) {
    const detailDataset = datasets.find(d => d.id === selectedId);
    const detailBackend = backends.find(
      b => b.id === detailDataset?.backend_id
    );
    return (
      <DatasetDetailPanel
        service={service}
        datasetId={selectedId}
        backend={detailBackend}
        onBack={() => setView('catalogue')}
        onOpenWorkflow={() => setView('catalogue')}
      />
    );
  }

  // --- Discover ---
  if (view === 'discover') {
    const isSubscribed = (ownerId: string) =>
      subscriptions.some(s => s.source_owner_id === ownerId);

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          fontFamily: 'var(--jp-ui-font-family)',
          fontSize: 'var(--jp-ui-font-size1)'
        }}
      >
        <div
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--jp-border-color2)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0
          }}
        >
          <button
            onClick={() => setView('catalogue')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--jp-ui-font-color2)',
              fontSize: 12,
              padding: 0
            }}
          >
            ←
          </button>
          <span style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>
            Discover published lakes
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
          {discoverLoading && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--jp-ui-font-color2)',
                padding: 16,
                textAlign: 'center'
              }}
            >
              Loading…
            </div>
          )}
          {discoverError && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--jp-error-color1)',
                padding: '8px 0'
              }}
            >
              {discoverError}
            </div>
          )}
          {!discoverLoading && discoverData.length === 0 && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--jp-ui-font-color2)',
                padding: 16,
                textAlign: 'center'
              }}
            >
              No published lakes found yet.
            </div>
          )}
          {discoverData.map(entry => (
            <div
              key={entry.lake.owner_id}
              style={{
                marginBottom: 16,
                border: '1px solid var(--jp-border-color2)',
                borderRadius: 6,
                overflow: 'hidden'
              }}
            >
              {/* Lake header */}
              <div
                style={{
                  padding: '8px 12px',
                  background: 'var(--jp-layout-color2)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>
                    {entry.lake.title || entry.lake.owner_id}
                  </div>
                  {entry.lake.description && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--jp-ui-font-color2)',
                        marginTop: 2
                      }}
                    >
                      {entry.lake.description}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--jp-ui-font-color2)',
                      marginTop: 2
                    }}
                  >
                    {entry.datasets.length} public dataset
                    {entry.datasets.length !== 1 ? 's' : ''}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    try {
                      setDiscoverError(null);
                      if (isSubscribed(entry.lake.owner_id)) {
                        const sub = subscriptions.find(
                          s => s.source_owner_id === entry.lake.owner_id
                        );
                        if (sub) {
                          await service.unsubscribe(sub.id);
                        }
                        setSubscriptions(prev =>
                          prev.filter(
                            s => s.source_owner_id !== entry.lake.owner_id
                          )
                        );
                        await loadAll();
                      } else {
                        await service.subscribe(entry.lake.owner_id);
                        const [subs, subDatasets] = await Promise.all([
                          service.getSubscriptions(),
                          service.getSubscribedDatasets()
                        ]);
                        setSubscriptions(subs);
                        setSubscribedDatasets(subDatasets);
                        await loadAll();
                      }
                    } catch (e: any) {
                      setDiscoverError(e.message ?? 'Subscribe failed');
                    }
                  }}
                  style={{
                    padding: '3px 10px',
                    fontSize: 11,
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: isSubscribed(entry.lake.owner_id)
                      ? 'var(--jp-layout-color3)'
                      : 'var(--jp-brand-color1)',
                    color: isSubscribed(entry.lake.owner_id)
                      ? 'var(--jp-ui-font-color1)'
                      : 'white',
                    border: 'none'
                  }}
                >
                  {isSubscribed(entry.lake.owner_id)
                    ? 'Subscribed ✓'
                    : 'Subscribe'}
                </button>
              </div>
              {/* Dataset list */}
              {entry.datasets.map((d: any) => (
                <div
                  key={d.id}
                  style={{
                    padding: '6px 12px',
                    borderTop: '1px solid var(--jp-border-color2)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8
                  }}
                >
                  <span style={{ flex: 1, fontSize: 12 }}>{d.name}</span>
                  {d.format && (
                    <span
                      style={{
                        fontSize: 10,
                        color: 'var(--jp-ui-font-color2)',
                        background: 'var(--jp-layout-color2)',
                        padding: '1px 5px',
                        borderRadius: 3
                      }}
                    >
                      {d.format}
                    </span>
                  )}
                  <button
                    disabled={importing === d.id || importedSourceIds.has(d.id)}
                    onClick={async () => {
                      setImporting(d.id);
                      setDiscoverError(null);
                      try {
                        await service.importDataset(d.id);
                        await loadAll();
                      } catch (e: any) {
                        setDiscoverError(e.message ?? 'Import failed');
                      } finally {
                        setImporting(null);
                      }
                    }}
                    style={{
                      padding: '2px 8px',
                      fontSize: 10,
                      background: importedSourceIds.has(d.id)
                        ? 'var(--jp-layout-color3)'
                        : 'var(--jp-brand-color1)',
                      color: importedSourceIds.has(d.id)
                        ? 'var(--jp-ui-font-color2)'
                        : 'white',
                      border: 'none',
                      borderRadius: 3,
                      cursor: importedSourceIds.has(d.id)
                        ? 'default'
                        : 'pointer',
                      opacity: importing === d.id ? 0.5 : 1
                    }}
                  >
                    {importing === d.id
                      ? '…'
                      : importedSourceIds.has(d.id)
                        ? 'Imported ✓'
                        : 'Import'}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // --- Catalogue ---
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--jp-ui-font-family)',
        fontSize: 'var(--jp-ui-font-size1)'
      }}
    >
      {/* Picker mode banner */}
      {pickerMode && (
        <div
          style={{
            padding: '6px 10px',
            background: 'var(--jp-brand-color1)',
            color: 'white',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0
          }}
        >
          <span>●</span>
          <span>Select a dataset to use as workflow input</span>
        </div>
      )}

      {/* Toolbar */}
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--jp-border-color2)',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexShrink: 0
        }}
      >
        <input
          style={{
            flex: 1,
            padding: '4px 8px',
            border: '1px solid var(--jp-border-color1)',
            borderRadius: 4,
            fontSize: 'var(--jp-ui-font-size1)',
            background: 'var(--jp-layout-color1)',
            color: 'var(--jp-ui-font-color1)'
          }}
          placeholder="Search datasets…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button style={btnPrimary} onClick={() => setView('add-storage')}>
          + Add storage
        </button>
        <button
          style={{
            ...btnPrimary,
            background: 'var(--jp-layout-color2)',
            color: 'var(--jp-ui-font-color1)'
          }}
          onClick={async () => {
            setView('discover');
            setDiscoverLoading(true);
            try {
              const [disc, subs, subDatasets] = await Promise.all([
                service.getDiscover(),
                service.getSubscriptions(),
                service.getSubscribedDatasets()
              ]);
              setDiscoverData(disc);
              setSubscriptions(subs);
              setSubscribedDatasets(subDatasets);
            } catch {
              /* ignore */
            } finally {
              setDiscoverLoading(false);
            }
          }}
        >
          🔭 Discover
        </button>
      </div>

      {/* Summary cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 6,
          padding: '8px 10px',
          flexShrink: 0
        }}
      >
        <StatCard label="Datasets" value={status?.total_dataset_count ?? 0} />
        <StatCard label="Backends" value={status?.backend_count ?? 0} />
        <StatCard
          label="Avg FAIR"
          value={`${avgFair}%`}
          color={fairColor(avgFair)}
        />
      </div>

      {/* Backend list with status dots */}
      {/* Collapsible backend section */}
      <div style={{ padding: '4px 10px 0', flexShrink: 0 }}>
        <div
          onClick={() => setBackendsOpen(o => !o)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            marginBottom: backendsOpen ? 4 : 0
          }}
        >
          <span
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--jp-ui-font-color2)',
              fontWeight: 500
            }}
          >
            Storage backends
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'var(--jp-ui-font-color2)',
              transition: 'transform 0.2s',
              display: 'inline-block',
              transform: backendsOpen ? 'rotate(180deg)' : 'none'
            }}
          >
            ▾
          </span>
        </div>
        {backendsOpen && (
          <>
            {backends.length === 0 ? (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--jp-ui-font-color2)',
                  padding: '6px 0'
                }}
              >
                No backends registered yet.
              </div>
            ) : (
              backends.map(b => (
                <BackendRow
                  key={b.id}
                  backend={b}
                  active={filterBackend === b.id}
                  status={
                    backendStatus[b.id] ??
                    (b.status === 'connected' ? 'ok' : 'error')
                  }
                  onSelect={() =>
                    setFilter(filterBackend === b.id ? 'all' : b.id)
                  }
                  onTest={() => testBackend(b.id)}
                  onDelete={() => deleteBackend(b.id)}
                />
              ))
            )}
            {backends.length > 0 && (
              <button
                onClick={() => setFilter('all')}
                style={{
                  fontSize: 11,
                  color:
                    filterBackend === 'all'
                      ? 'var(--jp-brand-color1)'
                      : 'var(--jp-ui-font-color2)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '3px 0',
                  display: 'block',
                  width: '100%',
                  textAlign: 'left'
                }}
              >
                Show all
              </button>
            )}
          </>
        )}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--jp-border-color2)',
          margin: '6px 0 0',
          flexShrink: 0
        }}
      />

      {/* Dataset count */}
      <div
        style={{
          padding: '4px 10px',
          fontSize: 11,
          color: 'var(--jp-ui-font-color2)',
          flexShrink: 0
        }}
      >
        {filtered.length} dataset{filtered.length !== 1 ? 's' : ''}
        {search && ` matching "${search}"`}
      </div>

      {/* Dataset list — tree view */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 10px' }}>
        {filtered.length === 0 ? (
          <EmptyState
            search={search}
            hasBackends={backends.length > 0}
            onClearSearch={() => setSearch('')}
            onAddStorage={() => setView('add-storage')}
          />
        ) : filterBackend === 'all' ? (
          <>
            {/* Own backends — tree view */}
            {backends.map(b => {
              const bDatasets = filtered.filter(
                d => d.backend_id === b.id && !d.source_owner_id
              );
              if (bDatasets.length === 0) {
                return null;
              }
              return (
                <div key={b.id}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: 'var(--jp-ui-font-color2)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      padding: '8px 0 4px'
                    }}
                  >
                    {b.name}
                  </div>
                  {renderTree(buildTree(bDatasets, b.root_path), 0, b)}
                </div>
              );
            })}
            {/* Imported datasets — backend belongs to another researcher */}
            {(() => {
              const ownBackendIds = new Set(backends.map(b => b.id));
              const importedDatasets = filtered.filter(
                d => !d.source_owner_id && !ownBackendIds.has(d.backend_id)
              );
              if (importedDatasets.length === 0) {
                return null;
              }
              return (
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: 'var(--jp-ui-font-color2)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      padding: '8px 0 4px'
                    }}
                  >
                    Imported
                  </div>
                  {importedDatasets.map(d => (
                    <DatasetRow
                      key={d.id}
                      dataset={d}
                      backend={undefined}
                      pickerMode={pickerMode}
                      onClick={() => {
                        if (pickerMode && onPickDataset) {
                          onPickDataset(d.pid ?? `dl:${d.id}`, d.name);
                        } else {
                          setSelectedId(d.id);
                          setView('detail');
                        }
                      }}
                    />
                  ))}
                </div>
              );
            })()}
            {/* Subscribed lakes — grouped by source owner */}
            {(() => {
              const subDatasets = filtered.filter(d => !!d.source_owner_id);
              const byOwner = subDatasets.reduce(
                (acc, d) => {
                  const owner = d.source_owner_id!;
                  if (!acc[owner]) {
                    acc[owner] = [];
                  }
                  acc[owner].push(d);
                  return acc;
                },
                {} as Record<string, Dataset[]>
              );
              return Object.entries(byOwner).map(([owner, ownerDatasets]) => (
                <div key={owner}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: '#27500A',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      padding: '8px 0 4px'
                    }}
                  >
                    📥 {owner}'s lake
                  </div>
                  {ownerDatasets.map(d => (
                    <DatasetRow
                      key={d.id}
                      dataset={d}
                      backend={backends.find(b => b.id === d.backend_id)}
                      pickerMode={pickerMode}
                      onClick={() => {
                        if (pickerMode && onPickDataset) {
                          onPickDataset(d.pid ?? `dl:${d.id}`, d.name);
                        } else {
                          setSelectedId(d.id);
                          setView('detail');
                        }
                      }}
                    />
                  ))}
                </div>
              ));
            })()}
          </>
        ) : (
          renderTree(
            buildTree(
              filtered.filter(d => !d.source_owner_id),
              backends.find(b => b.id === filterBackend)?.root_path ?? ''
            ),
            0,
            backends.find(b => b.id === filterBackend)
          )
        )}
      </div>

      {/* Status bar */}
      <StatusBar
        status={status}
        publishLoading={publishLoading}
        onTogglePublish={handlePublishToggle}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tree building and rendering
// ---------------------------------------------------------------------------

type TreeNode =
  | { type: 'dir'; name: string; path: string; children: TreeNode[] }
  | { type: 'file'; dataset: Dataset };

function buildTree(datasets: Dataset[], rootPath: string): TreeNode[] {
  const root: TreeNode[] = [];

  const normalize = (p: string) => {
    let rel = p;
    if (rootPath) {
      if (p.startsWith(rootPath + '/')) {
        rel = p.slice(rootPath.length + 1);
      } else if (p.startsWith(rootPath)) {
        rel = p.slice(rootPath.length);
      }
    }
    return rel.replace(/^\/+/, '');
  };

  for (const d of [...datasets].sort((a, b) => a.path.localeCompare(b.path))) {
    const rel = normalize(d.path);
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let level = root;
    let pathSoFar = rootPath || '';

    for (let i = 0; i < parts.length - 1; i++) {
      pathSoFar = pathSoFar + '/' + parts[i];
      let dir = level.find(n => n.type === 'dir' && n.name === parts[i]) as
        | (TreeNode & { type: 'dir' })
        | undefined;
      if (!dir) {
        dir = { type: 'dir', name: parts[i], path: pathSoFar, children: [] };
        level.push(dir);
      }
      level = dir.children;
    }

    level.push({ type: 'file', dataset: d });
  }

  return root;
}

function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce(
    (acc, n) => (n.type === 'file' ? acc + 1 : acc + countFiles(n.children)),
    0
  );
}

// renderTree is defined inside DataLakePanel to capture local state
// (expanded, toggleDir, pickerMode, onPickDataset, setSelectedId, setView)

// ---------------------------------------------------------------------------
// BackendRow
// ---------------------------------------------------------------------------

interface BackendRowProps {
  backend: StorageBackend;
  active: boolean;
  status: 'ok' | 'error' | 'testing';
  onSelect: () => void;
  onTest: () => void;
  onDelete: () => void;
}

const BackendRow: React.FC<BackendRowProps> = ({
  backend,
  active,
  status,
  onSelect,
  onTest,
  onDelete
}) => {
  const bc = BACKEND_COLORS[backend.type] ?? { bg: '#F1EFE8', text: '#2C2C2A' };
  const dotColor =
    status === 'ok' ? '#3B6D11' : status === 'error' ? '#A32D2D' : '#C07A00';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 6px',
        borderRadius: 4,
        cursor: 'pointer',
        marginBottom: 2,
        background: active ? 'var(--jp-brand-color4)' : 'transparent',
        border: active
          ? '1px solid var(--jp-brand-color2)'
          : '1px solid transparent'
      }}
      onClick={onSelect}
    >
      {/* Status dot */}
      {status === 'testing' ? (
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 7,
            border: `1.5px solid ${dotColor}`,
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'vrefs-spin 0.8s linear infinite',
            flexShrink: 0
          }}
        />
      ) : (
        <span style={{ fontSize: 8, color: dotColor, flexShrink: 0 }}>●</span>
      )}

      {/* Backend type badge */}
      <span
        style={{
          fontSize: 10,
          padding: '1px 5px',
          borderRadius: 6,
          background: bc.bg,
          color: bc.text,
          fontWeight: 500,
          flexShrink: 0
        }}
      >
        {BACKEND_LABELS[backend.type]}
      </span>

      {/* Name */}
      <span
        style={{
          fontSize: 11,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--jp-ui-font-color1)'
        }}
      >
        {backend.name}
      </span>

      {/* Dataset count */}
      <span
        style={{
          fontSize: 10,
          color: 'var(--jp-ui-font-color2)',
          flexShrink: 0
        }}
      >
        {backend.dataset_count}
      </span>

      {/* Test button */}
      <button
        onClick={e => {
          e.stopPropagation();
          onTest();
        }}
        title="Test connection"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--jp-ui-font-color2)',
          fontSize: 12,
          padding: '0 2px',
          lineHeight: 1,
          flexShrink: 0
        }}
      >
        ↺
      </button>

      {/* Delete button */}
      <button
        onClick={e => {
          e.stopPropagation();
          if (window.confirm(`Remove backend "${backend.name}"?`)) {
            onDelete();
          }
        }}
        title="Remove backend"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--jp-ui-font-color2)',
          fontSize: 12,
          padding: '0 2px',
          lineHeight: 1,
          flexShrink: 0
        }}
      >
        ✕
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DatasetRow
// ---------------------------------------------------------------------------

interface RowProps {
  dataset: Dataset;
  backend: StorageBackend | undefined;
  pickerMode: boolean;
  onClick: () => void;
}

const DatasetRow: React.FC<RowProps> = ({
  dataset,
  backend,
  pickerMode,
  onClick
}) => {
  const score = fairTotal(dataset.fair_score);
  const st = STATUS_COLORS[dataset.status];
  const bc = backend
    ? BACKEND_COLORS[backend.type]
    : { bg: '#F1EFE8', text: '#2C2C2A' };

  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 0',
        borderBottom: '1px solid var(--jp-border-color2)',
        cursor: 'pointer'
      }}
      onMouseEnter={e =>
        (e.currentTarget.style.background = 'var(--jp-layout-color2)')
      }
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          justifyContent: 'space-between',
          marginBottom: 4
        }}
      >
        <span
          style={{
            fontWeight: 500,
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1
          }}
        >
          {dataset.name}
        </span>
        {pickerMode ? (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'var(--jp-brand-color1)',
              color: 'white',
              flexShrink: 0
            }}
          >
            Select
          </span>
        ) : (
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: fairColor(score),
              background: fairBg(score),
              padding: '1px 5px',
              borderRadius: 8,
              flexShrink: 0
            }}
          >
            {score}%
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 8,
            background: bc.bg,
            color: bc.text,
            fontWeight: 500
          }}
        >
          {backend ? BACKEND_LABELS[backend.type] : dataset.backend_id}
        </span>
        {dataset.source_owner_id && (
          <span
            style={{
              fontSize: 9,
              padding: '1px 5px',
              borderRadius: 8,
              background: '#EAF3DE',
              color: '#27500A',
              fontWeight: 500
            }}
          >
            📥 {dataset.source_owner_id}
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 8,
            background: 'var(--jp-layout-color2)',
            color: 'var(--jp-ui-font-color2)',
            fontFamily: 'var(--jp-code-font-family)'
          }}
        >
          {dataset.format}
        </span>
        <span style={{ fontSize: 10, color: 'var(--jp-ui-font-color2)' }}>
          {dataset.size}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 8,
            background: st.bg,
            color: st.text,
            border: `1px solid ${st.border}`,
            marginLeft: 'auto'
          }}
        >
          {dataset.status}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

interface StatusBarProps {
  status: DataLakeStatus | null;
  publishLoading: boolean;
  onTogglePublish: () => void;
}

const StatusBar: React.FC<StatusBarProps> = ({
  status,
  publishLoading,
  onTogglePublish
}) => (
  <div
    style={{
      padding: '5px 10px',
      background: 'var(--jp-brand-color1)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexShrink: 0
    }}
  >
    <span style={{ fontSize: 11, color: 'white', fontWeight: 500 }}>vreFS</span>
    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
      {status?.total_dataset_count ?? 0} datasets
    </span>
    <div style={{ flex: 1 }} />
    {status?.published && status.public_url && (
      <a
        href={status.public_url}
        target="_blank"
        rel="noreferrer"
        style={{ fontSize: 10, color: '#9FE1CB', textDecoration: 'none' }}
      >
        ↗ public lake
      </a>
    )}
    <button
      onClick={onTogglePublish}
      disabled={publishLoading}
      title={status?.published ? 'Unpublish lake' : 'Publish lake'}
      style={{
        padding: '2px 7px',
        fontSize: 10,
        border: 'none',
        borderRadius: 3,
        cursor: 'pointer',
        background: status?.published ? '#9FE1CB' : 'rgba(255,255,255,0.2)',
        color: status?.published ? '#04342C' : 'white',
        opacity: publishLoading ? 0.6 : 1
      }}
    >
      {publishLoading ? '…' : status?.published ? '● published' : '○ private'}
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  search: string;
  hasBackends: boolean;
  onClearSearch: () => void;
  onAddStorage: () => void;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  search,
  hasBackends,
  onClearSearch,
  onAddStorage
}) => {
  if (search) {
    return (
      <div style={{ padding: '24px 10px', textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>🔍</div>
        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
          No datasets match "{search}"
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--jp-ui-font-color2)',
            marginBottom: 12
          }}
        >
          Try a different keyword or clear the search.
        </div>
        <button onClick={onClearSearch} style={btnSecondary}>
          Clear search
        </button>
      </div>
    );
  }

  if (!hasBackends) {
    return (
      <div style={{ padding: '24px 10px', textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>🗄️</div>
        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
          No storage connected yet
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--jp-ui-font-color2)',
            marginBottom: 12
          }}
        >
          Connect your first storage backend to start building your personal
          data lake.
        </div>
        <button onClick={onAddStorage} style={btnPrimary}>
          + Add storage
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 10px', textAlign: 'center' }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>📂</div>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
        No datasets found
      </div>
      <div style={{ fontSize: 11, color: 'var(--jp-ui-font-color2)' }}>
        This backend appears to be empty.
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// LoadingSkeleton
// ---------------------------------------------------------------------------

const LoadingSkeleton: React.FC = () => (
  <div style={{ padding: 10, fontFamily: 'var(--jp-ui-font-family)' }}>
    {[80, 100, 60, 90, 70].map((w, i) => (
      <div key={i} style={{ marginBottom: 12 }}>
        <div
          style={{
            height: 12,
            width: `${w}%`,
            background: 'var(--jp-layout-color2)',
            borderRadius: 4,
            marginBottom: 6,
            animation: 'vrefs-pulse 1.4s ease-in-out infinite',
            animationDelay: `${i * 0.1}s`
          }}
        />
        <div
          style={{
            height: 9,
            width: '50%',
            background: 'var(--jp-layout-color2)',
            borderRadius: 4,
            opacity: 0.6
          }}
        />
      </div>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const StatCard: React.FC<{
  label: string;
  value: string | number;
  color?: string;
}> = ({ label, value, color }) => (
  <div
    style={{
      background: 'var(--jp-layout-color2)',
      borderRadius: 4,
      padding: '6px 8px',
      textAlign: 'center'
    }}
  >
    <div
      style={{
        fontSize: 18,
        fontWeight: 500,
        color: color ?? 'var(--jp-ui-font-color1)'
      }}
    >
      {value}
    </div>
    <div style={{ fontSize: 11, color: 'var(--jp-ui-font-color2)' }}>
      {label}
    </div>
  </div>
);

const btnPrimary: React.CSSProperties = {
  padding: '4px 8px',
  background: 'var(--jp-brand-color1)',
  color: 'white',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap'
};

const btnSecondary: React.CSSProperties = {
  padding: '4px 10px',
  background: 'none',
  color: 'var(--jp-ui-font-color1)',
  border: '1px solid var(--jp-border-color1)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12
};

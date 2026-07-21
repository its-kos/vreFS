import * as React from 'react';
import { VreFSService, Dataset } from '../service';
import {
  fairTotal,
  BACKEND_LABELS,
  BACKEND_COLORS,
  STATUS_COLORS
} from '../utils';
import { MetadataEditor } from './MetadataEditor';
import { FAIRChecklist, FAIRAction } from './FAIRChecklist';

interface Props {
  service: VreFSService;
  datasetId: string;
  backend?: import('../service').StorageBackend;
  onBack: () => void;
  onOpenWorkflow: (dataset: Dataset) => void;
}

type DetailView = 'detail' | 'editing' | 'staging';

export const DatasetDetailPanel: React.FC<Props> = ({
  service,
  datasetId,
  backend,
  onBack,
  onOpenWorkflow
}) => {
  const [dataset, setDataset] = React.useState<Dataset | null>(null);
  const [local, setLocal] = React.useState<Dataset | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [detailView, setDetailView] = React.useState<DetailView>('detail');
  const [pidLoading, setPidLoading] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [snippetCopied, setSnippetCopied] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);
  const [statusSaving, setStatusSaving] = React.useState(false);
  const [stagingStatus, setStagingStatus] = React.useState<
    import('../service').StagedDataset | null
  >(null);
  const [stagingError, setStagingError] = React.useState<string | null>(null);
  const stagingPollRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  React.useEffect(() => {
    service
      .getDataset(datasetId)
      .then(d => {
        setDataset(d);
        setLocal(d);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [datasetId]);

  const active = local ?? dataset;

  async function handleAssignPID() {
    if (!active) {
      return;
    }
    setPidLoading(true);
    try {
      const { pid } = await service.assignPID(active.id);
      setLocal({ ...active, pid });
    } finally {
      setPidLoading(false);
    }
  }

  async function handleStatusChange(newStatus: Dataset['status']) {
    if (!active) {
      return;
    }
    setStatusSaving(true);
    setStatusOpen(false);
    try {
      const updated = await service.publishDataset(active.id, newStatus);
      setLocal(updated);
    } finally {
      setStatusSaving(false);
    }
  }

  function handleMetaSave(updated: Dataset) {
    setLocal(updated);
    setDetailView('detail');
  }

  async function handleStage() {
    if (!active) {
      return;
    }
    setStagingStatus(null);
    setStagingError(null);
    setDetailView('staging');

    try {
      const isLocal = backend?.type === 'local';
      const staged = isLocal
        ? await service.requestLocalStaging(active.id, '', active.path)
        : await service.requestStaging(active.id, '');

      setStagingStatus(staged);

      // Poll until terminal state
      if (staged.status === 'pending' || staged.status === 'copying') {
        const poll = async () => {
          try {
            const current = await service.getStagingStatus(staged.id);
            setStagingStatus(current);
            if (current.status === 'pending' || current.status === 'copying') {
              stagingPollRef.current = setTimeout(poll, 2000);
            }
          } catch (e: any) {
            setStagingError(e.message);
          }
        };
        stagingPollRef.current = setTimeout(poll, 2000);
      }
    } catch (e: any) {
      setStagingError(e.message ?? 'Staging failed');
    }
  }

  React.useEffect(() => {
    return () => {
      if (stagingPollRef.current) {
        clearTimeout(stagingPollRef.current);
      }
    };
  }, []);

  function copyPID() {
    if (!active?.pid) {
      return;
    }
    navigator.clipboard.writeText(active.pid);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function getSnippet() {
    if (!active?.pid) {
      return '';
    }
    return `import vrefs\n\nf = vrefs.get("${active.pid}")`;
  }

  function copySnippet() {
    if (!active) {
      return;
    }
    navigator.clipboard.writeText(getSnippet());
    setSnippetCopied(true);
    setTimeout(() => setSnippetCopied(false), 1500);
  }

  function handleFAIRFix(action: FAIRAction) {
    if (action === 'assign-pid') {
      handleAssignPID();
    } else {
      setDetailView('editing');
    }
  }

  if (loading) {
    return (
      <div
        style={{
          padding: 16,
          fontSize: 12,
          color: 'var(--jp-ui-font-color2)',
          fontFamily: 'var(--jp-ui-font-family)'
        }}
      >
        Loading dataset...
      </div>
    );
  }

  if (error || !active) {
    return (
      <div
        style={{
          padding: 16,
          fontSize: 12,
          color: 'var(--jp-error-color1)',
          fontFamily: 'var(--jp-ui-font-family)'
        }}
      >
        {error ?? 'Dataset not found'}
      </div>
    );
  }

  if (detailView === 'staging') {
    const stagingPath =
      stagingStatus?.staging_path ?? stagingStatus?.staged_key;
    const isReady = stagingStatus?.status === 'ready';
    const isFailed = stagingStatus?.status === 'error' || !!stagingError;
    const isPending = !isReady && !isFailed;

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
            onClick={() => {
              if (stagingPollRef.current) {
                clearTimeout(stagingPollRef.current);
              }
              setDetailView('detail');
            }}
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
          <span style={{ fontSize: 12, fontWeight: 500 }}>
            Stage for workflow
          </span>
        </div>
        <div
          style={{
            flex: 1,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--jp-ui-font-color2)' }}>
            Dataset:{' '}
            <strong style={{ color: 'var(--jp-ui-font-color1)' }}>
              {active.name}
            </strong>
          </div>

          {/* Status */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              background: isFailed
                ? '#FAEEDA'
                : isReady
                  ? '#EAF3DE'
                  : 'var(--jp-layout-color2)',
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            {isPending && <span style={{ fontSize: 16 }}>⏳</span>}
            {isReady && <span style={{ fontSize: 16 }}>✅</span>}
            {isFailed && <span style={{ fontSize: 16 }}>❌</span>}
            <span
              style={{
                fontSize: 12,
                color: isFailed
                  ? '#633806'
                  : isReady
                    ? '#27500A'
                    : 'var(--jp-ui-font-color1)'
              }}
            >
              {isFailed
                ? (stagingError ??
                  stagingStatus?.error_message ??
                  'Staging failed')
                : isReady
                  ? 'Ready — dataset is staged to NaaVRE MinIO'
                  : stagingStatus?.status === 'copying'
                    ? 'Copying to staging bucket…'
                    : 'Requesting staging…'}
            </span>
          </div>

          {/* Staging path */}
          {isReady && stagingPath && (
            <>
              <div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--jp-ui-font-color2)',
                    marginBottom: 4
                  }}
                >
                  Staging path
                </div>
                <div
                  style={{
                    fontFamily: 'var(--jp-code-font-family)',
                    fontSize: 11,
                    padding: '6px 8px',
                    background: 'var(--jp-layout-color2)',
                    borderRadius: 4,
                    wordBreak: 'break-all'
                  }}
                >
                  {stagingPath}
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--jp-ui-font-color2)',
                    marginBottom: 4
                  }}
                >
                  Use in a notebook cell
                </div>
                <pre
                  style={{
                    fontFamily: 'var(--jp-code-font-family)',
                    fontSize: 11,
                    padding: '8px',
                    background: 'var(--jp-layout-color2)',
                    borderRadius: 4,
                    margin: 0,
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {`import vrefs\n\nf = vrefs.get("${active?.pid ?? ''}")`}
                </pre>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--jp-ui-font-color2)',
                    marginTop: 4
                  }}
                >
                  Workflow containers receive the staged copy automatically,
                  mounted at the path above &mdash; no code needed there.
                </div>
              </div>
            </>
          )}

          {/* Retry */}
          {isFailed && (
            <button
              onClick={handleStage}
              style={{
                padding: '5px 12px',
                background: 'var(--jp-brand-color1)',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                alignSelf: 'flex-start'
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (detailView === 'editing') {
    return (
      <MetadataEditor
        service={service}
        dataset={active}
        onSave={handleMetaSave}
        onCancel={() => setDetailView('detail')}
      />
    );
  }

  const score = fairTotal(active.fair_score);
  const st = STATUS_COLORS[active.status];
  const bc = BACKEND_COLORS[
    active.backend_id as keyof typeof BACKEND_COLORS
  ] ?? { bg: '#F1EFE8', text: '#2C2C2A' };

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
      {/* Header */}
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
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--jp-ui-font-color1)',
            fontSize: 16,
            padding: 0,
            lineHeight: 1
          }}
        >
          ‹
        </button>
        <span
          style={{
            fontWeight: 500,
            fontSize: 12,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {active.name}
        </span>
        {active.source_owner_id && (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: '#EAF3DE',
              color: '#27500A',
              flexShrink: 0
            }}
          >
            📥 {active.source_owner_id}
          </span>
        )}
        <button
          onClick={() => handleStage()}
          style={{
            padding: '3px 8px',
            background: 'var(--jp-brand-color1)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 11,
            flexShrink: 0
          }}
        >
          Use in workflow
        </button>
        {active.source_owner_id && (
          <button
            onClick={async () => {
              try {
                await service.importDataset(active.id);
                onBack();
              } catch (e: any) {
                setError(e.message ?? 'Import failed');
              }
            }}
            style={{
              padding: '3px 8px',
              background: 'var(--jp-layout-color2)',
              color: 'var(--jp-ui-font-color1)',
              border: '1px solid var(--jp-border-color2)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
              flexShrink: 0
            }}
          >
            Import to my lake
          </button>
        )}
        {active.source_dataset_ids?.length && !active.source_owner_id && (
          <button
            onClick={async () => {
              if (!window.confirm(`Remove "${active.name}" from your lake?`)) {
                return;
              }
              try {
                await service.deleteDataset(active.id);
                onBack();
              } catch (e: any) {
                setError(e.message ?? 'Remove failed');
              }
            }}
            style={{
              padding: '3px 8px',
              background: 'none',
              color: 'var(--jp-error-color1)',
              border: '1px solid var(--jp-error-color1)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
              flexShrink: 0
            }}
          >
            Remove
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {/* Badges row — status badge is clickable */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
            marginBottom: 8,
            alignItems: 'center'
          }}
        >
          <span
            style={{
              fontSize: 11,
              padding: '2px 7px',
              borderRadius: 8,
              background: bc.bg,
              color: bc.text,
              fontWeight: 500
            }}
          >
            {BACKEND_LABELS[active.backend_id as keyof typeof BACKEND_LABELS] ??
              active.backend_id}
          </span>

          {/* Clickable status badge with dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setStatusOpen(o => !o)}
              disabled={statusSaving}
              style={{
                fontSize: 11,
                padding: '2px 7px',
                borderRadius: 8,
                background: st.bg,
                color: st.text,
                border: `1px solid ${st.border}`,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 3
              }}
            >
              {statusSaving ? '…' : active.status} ▾
            </button>
            {statusOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  zIndex: 100,
                  background: 'var(--jp-layout-color1)',
                  border: '1px solid var(--jp-border-color1)',
                  borderRadius: 4,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                  minWidth: 110,
                  marginTop: 2
                }}
              >
                {(['private', 'public'] as Dataset['status'][]).map(s => {
                  const c = STATUS_COLORS[s];
                  return (
                    <div
                      key={s}
                      onClick={() => handleStatusChange(s)}
                      style={{
                        padding: '6px 10px',
                        cursor: 'pointer',
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        background:
                          active.status === s
                            ? 'var(--jp-layout-color2)'
                            : 'transparent'
                      }}
                      onMouseEnter={e =>
                        (e.currentTarget.style.background =
                          'var(--jp-layout-color2)')
                      }
                      onMouseLeave={e =>
                        (e.currentTarget.style.background =
                          active.status === s
                            ? 'var(--jp-layout-color2)'
                            : 'transparent')
                      }
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: c.text,
                          flexShrink: 0
                        }}
                      />
                      <span style={{ color: 'var(--jp-ui-font-color1)' }}>
                        {s}
                      </span>
                      {active.status === s && (
                        <span
                          style={{
                            marginLeft: 'auto',
                            color: 'var(--jp-brand-color1)'
                          }}
                        >
                          ✓
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <span
            style={{
              fontSize: 11,
              padding: '2px 7px',
              borderRadius: 8,
              fontFamily: 'var(--jp-code-font-family)',
              background: 'var(--jp-layout-color2)',
              color: 'var(--jp-ui-font-color2)'
            }}
          >
            {active.format}
          </span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--jp-ui-font-color2)',
              padding: '2px 0'
            }}
          >
            {active.size}
          </span>
        </div>

        {/* Description */}
        <p
          style={{
            fontSize: 12,
            color: 'var(--jp-ui-font-color2)',
            marginBottom: 8,
            lineHeight: 1.5
          }}
        >
          {active.description || (
            <em style={{ opacity: 0.6 }}>
              No description — add one to improve your FAIR score.
            </em>
          )}
        </p>

        {/* Tags + edit button */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
            marginBottom: 10
          }}
        >
          {active.tags.map(t => (
            <span
              key={t}
              style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 4,
                background: 'var(--jp-layout-color2)',
                color: 'var(--jp-ui-font-color2)',
                border: '1px solid var(--jp-border-color1)'
              }}
            >
              {t}
            </span>
          ))}
          <button
            onClick={() => setDetailView('editing')}
            style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 4,
              background: 'none',
              color: 'var(--jp-brand-color1)',
              border: '1px dashed var(--jp-brand-color2)',
              cursor: 'pointer',
              display: active.source_owner_id ? 'none' : undefined
            }}
          >
            + Edit metadata
          </button>
        </div>

        {/* PID banner */}
        {active.pid ? (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 4,
              background: 'var(--jp-layout-color2)',
              border: '1px solid var(--jp-border-color1)',
              marginBottom: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--jp-ui-font-color2)',
                  marginBottom: 2
                }}
              >
                Persistent identifier
              </div>
              <code
                style={{
                  fontSize: 11,
                  color: 'var(--jp-brand-color1)',
                  fontFamily: 'var(--jp-code-font-family)',
                  wordBreak: 'break-all'
                }}
              >
                {active.pid}
              </code>
            </div>
            <button
              onClick={copyPID}
              style={{
                padding: '3px 7px',
                background: 'none',
                border: '1px solid var(--jp-border-color1)',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
                color: 'var(--jp-ui-font-color1)',
                flexShrink: 0
              }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 4,
              background: '#FAEEDA',
              border: '1px solid #FAC775',
              marginBottom: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6
            }}
          >
            <span style={{ fontSize: 11, color: '#633806' }}>
              No PID — this dataset is not yet citable.
            </span>
            <button
              onClick={handleAssignPID}
              disabled={pidLoading}
              style={{
                padding: '3px 8px',
                background: '#854F0B',
                color: '#FAEEDA',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
                flexShrink: 0,
                opacity: pidLoading ? 0.6 : 1
              }}
            >
              {pidLoading ? '...' : 'Assign PID'}
            </button>
          </div>
        )}

        {/* Metadata */}
        <Section title="Metadata">
          {(
            [
              ['Format', active.format],
              ['Size', active.size],
              ['Domain', active.domain],
              ['Modified', active.modified],
              ['Versions', String(active.versions)],
              ['Licence', active.licence ?? '—'],
              ['Path', active.path]
            ] as [string, string][]
          ).map(([k, v]) => (
            <MetaRow key={k} label={k} value={v} mono={k === 'Path'} />
          ))}
        </Section>

        {/* FAIR checklist */}
        <Section title="FAIR score">
          <FAIRChecklist dataset={active} onFixItem={handleFAIRFix} />
        </Section>

        {/* Provenance */}
        {active.provenance && (
          <Section title="Provenance">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                flexWrap: 'wrap',
                fontSize: 11
              }}
            >
              <span
                style={{
                  padding: '3px 7px',
                  borderRadius: 4,
                  background: '#EEEDFE',
                  color: '#26215C',
                  fontFamily: 'var(--jp-code-font-family)'
                }}
              >
                {active.provenance.input_dataset_ids.join(', ')}
              </span>
              <span style={{ color: 'var(--jp-ui-font-color2)' }}>→</span>
              <span
                style={{
                  padding: '3px 7px',
                  borderRadius: 4,
                  background: '#E6F1FB',
                  color: '#0C447C',
                  fontFamily: 'var(--jp-code-font-family)'
                }}
              >
                {active.provenance.source_label}
              </span>
              <span style={{ color: 'var(--jp-ui-font-color2)' }}>→</span>
              <span
                style={{
                  padding: '3px 7px',
                  borderRadius: 4,
                  background: '#EAF3DE',
                  color: '#27500A',
                  fontFamily: 'var(--jp-code-font-family)',
                  fontWeight: 500
                }}
              >
                {active.name.substring(0, 22)}
              </span>
            </div>
          </Section>
        )}

        {/* Notebook snippet */}
        <Section title="Use in notebook">
          <div style={{ position: 'relative' }}>
            <div
              style={{
                background: 'var(--jp-layout-color0)',
                border: '1px solid var(--jp-border-color1)',
                borderRadius: 4,
                padding: '8px 36px 8px 10px'
              }}
            >
              <code
                style={{
                  fontFamily: 'var(--jp-code-font-family)',
                  fontSize: 11,
                  color: 'var(--jp-mirror-editor-keyword-color)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all'
                }}
              >
                {getSnippet()}
              </code>
            </div>
            <button
              onClick={copySnippet}
              style={{
                position: 'absolute',
                top: 5,
                right: 5,
                padding: '2px 6px',
                fontSize: 10,
                background: 'var(--jp-layout-color2)',
                border: '1px solid var(--jp-border-color1)',
                borderRadius: 3,
                cursor: 'pointer',
                color: 'var(--jp-ui-font-color2)'
              }}
            >
              {snippetCopied ? '✓' : 'Copy'}
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children
}) => (
  <div style={{ marginBottom: 14 }}>
    <div
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: 'var(--jp-ui-font-color2)',
        fontWeight: 500,
        marginBottom: 6,
        paddingBottom: 4,
        borderBottom: '1px solid var(--jp-border-color2)'
      }}
    >
      {title}
    </div>
    {children}
  </div>
);

const MetaRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono
}) => (
  <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12 }}>
    <span
      style={{ color: 'var(--jp-ui-font-color2)', width: 70, flexShrink: 0 }}
    >
      {label}
    </span>
    <span
      style={{
        fontFamily: mono ? 'var(--jp-code-font-family)' : undefined,
        wordBreak: 'break-all',
        color: 'var(--jp-ui-font-color1)',
        fontSize: mono ? 11 : 12
      }}
    >
      {value}
    </span>
  </div>
);

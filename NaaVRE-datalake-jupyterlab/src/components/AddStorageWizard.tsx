import * as React from 'react';
import {
  VreFSService,
  StorageBackend,
  RegisterBackendPayload
} from '../service';
import { BACKEND_LABELS } from '../utils';

interface Props {
  service: VreFSService;
  onDone: () => void;
  onCancel: () => void;
}

type BackendType = StorageBackend['type'];
type Step = 1 | 2 | 3 | 4;

interface CheckItem {
  label: string;
  status: 'ok' | 'running' | 'pending' | 'error';
}

const BACKEND_TYPES: { type: BackendType; icon: string; desc: string }[] = [
  { type: 'local', icon: '💻', desc: 'Files on this machine' },
  { type: 's3', icon: '☁️', desc: 'S3, MinIO, Ceph' },
  {
    type: 'webdav',
    icon: '🌐',
    desc: 'SURF Research Drive, Nextcloud, ownCloud'
  },
  { type: 'github', icon: '🐙', desc: 'Public or private repo' },
  { type: 'irods', icon: '🏛', desc: 'SURF iRODS, LifeWatch iRODS' },
  { type: 'gdrive', icon: '📁', desc: 'Google Drive' }
];

export const AddStorageWizard: React.FC<Props> = ({
  service,
  onDone,
  onCancel
}) => {
  const [step, setStep] = React.useState<Step>(1);
  const [beType, setBeType] = React.useState<BackendType | null>(null);
  const [name, setName] = React.useState('');
  const [host, setHost] = React.useState('');
  const [rootPath, setRootPath] = React.useState('');
  const [s3Bucket, setS3Bucket] = React.useState('');
  const [s3AccessKeyVar, setS3AccessKeyVar] = React.useState('');
  const [s3SecretKeyVar, setS3SecretKeyVar] = React.useState('');
  const [githubTokenVar, setGithubTokenVar] = React.useState('');
  const [webdavUsernameVar, setWebdavUsernameVar] = React.useState('');
  const [webdavPasswordVar, setWebdavPasswordVar] = React.useState('');
  const [token, setToken] = React.useState('');
  const [checks, setChecks] = React.useState<CheckItem[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<StorageBackend | null>(null);

  function stepLabel(s: number) {
    return ['Choose type', 'Configure', 'Test', 'Done'][s - 1];
  }

  /**
   * Verify the backend path is reachable before registering.
   * For local backends: calls the Jupyter server's local browse handler.
   * For S3: calls Django's test endpoint after registration.
   */
  async function runTest() {
    setSubmitting(true);
    setChecks([{ label: 'Checking connection…', status: 'running' }]);
    setStep(3);

    try {
      if (beType === 'local') {
        await service.browseLocalBackend(rootPath);
        setChecks([{ label: `Path accessible: ${rootPath}`, status: 'ok' }]);
      } else {
        // For remote backends, test happens after registration in handleConfirm
        setChecks([{ label: 'Ready to register', status: 'ok' }]);
      }
    } catch (e: any) {
      setChecks([
        { label: e.message || 'Path not accessible', status: 'error' }
      ]);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Register the backend with Django via the communicator, then
   * auto-index it — walk the root directory and create a Dataset record
   * for every file found. This populates the main dataset list immediately
   * after registration without any manual browse-and-register step.
   *
   * For local backends: the extension reads the filesystem directly.
   * For remote backends: Django's find_all_files walks via fsspec
   * (called via the /index/ action added to StorageBackendViewSet).
   */
  async function handleConfirm() {
    if (!beType) {
      return;
    }
    setSubmitting(true);

    const credentials =
      beType === 'local'
        ? { provider: 'none' }
        : beType === 's3'
          ? {
              provider: 'env',
              vars: { access_key: s3AccessKeyVar, secret_key: s3SecretKeyVar }
            }
          : beType === 'github'
            ? githubTokenVar
              ? { provider: 'env', vars: { token: githubTokenVar } }
              : { provider: 'none' }
            : beType === 'webdav'
              ? {
                  provider: 'env',
                  vars: {
                    username: webdavUsernameVar,
                    password: webdavPasswordVar
                  }
                }
              : { provider: 'env', vars: {} };

    const backendRootPath = beType === 's3' ? s3Bucket : rootPath;
    const endpointUrl =
      beType === 's3'
        ? host
        : beType === 'github'
          ? host
          : beType === 'webdav'
            ? host
            : '';

    const payload: RegisterBackendPayload = {
      name: name || BACKEND_LABELS[beType],
      type: beType,
      credentials,
      root_path: backendRootPath,
      endpoint_url: endpointUrl
    };

    let registered: StorageBackend;
    try {
      registered = await service.registerBackend(payload);
    } catch (e: any) {
      setChecks(prev => [
        ...prev,
        { label: `Registration failed: ${e.message}`, status: 'error' }
      ]);
      setSubmitting(false);
      return;
    }

    setChecks(prev => [
      ...prev,
      { label: 'Indexing files…', status: 'running' }
    ]);

    // Auto-index: create a Dataset record for every file on the backend
    let indexed = 0;
    try {
      if (beType === 'local') {
        // Extension reads local filesystem recursively
        const files = await service.listLocalFiles(rootPath);
        for (const file of files) {
          try {
            const dataset = await service.createDataset({
              backend: registered.id,
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
              /* metadata enrichment is best-effort */
            }
            indexed++;
          } catch {
            /* skip files that fail */
          }
        }
      } else {
        // Remote backends: Django walks via fsspec directly
        // First test the connection, then index
        setChecks(prev =>
          prev.map(c =>
            c.label === 'Indexing files…'
              ? { ...c, label: 'Testing connection…', status: 'running' }
              : c
          )
        );
        const testResult = await service.testBackend(registered.id);
        if (!testResult.ok) {
          // Test failed — delete the backend record so it doesn't
          // show up in the list with a red status
          try {
            await service.deleteBackend(registered.id);
          } catch {
            /* ignore */
          }
          setChecks(prev =>
            prev.map(c =>
              c.label === 'Testing connection…'
                ? { ...c, status: 'error' as const, detail: testResult.message }
                : c
            )
          );
          setSubmitting(false);
          return;
        }
        setChecks(prev => [
          ...prev.map(c =>
            c.label === 'Testing connection…'
              ? {
                  ...c,
                  status: 'ok' as const,
                  detail: `${testResult.latency_ms}ms`
                }
              : c
          ),
          { label: 'Indexing files…', status: 'running' as const }
        ]);
        try {
          const indexResult = await service.indexRemoteBackend(registered.id);
          indexed = indexResult.indexed ?? 0;
          setChecks(prev =>
            prev.map(c =>
              c.label === 'Indexing files…'
                ? {
                    ...c,
                    status: 'ok' as const,
                    detail: `${indexed} file${indexed !== 1 ? 's' : ''} registered`
                  }
                : c
            )
          );
        } catch (e: any) {
          setChecks(prev =>
            prev.map(c =>
              c.label === 'Indexing files…'
                ? { ...c, status: 'error' as const, detail: e.message }
                : c
            )
          );
        }
      }
      setChecks(prev =>
        prev.map(c =>
          c.label === 'Indexing files…'
            ? {
                ...c,
                status: 'ok',
                detail: `${indexed} file${indexed !== 1 ? 's' : ''} registered`
              }
            : c
        )
      );
    } catch (e: any) {
      setChecks(prev =>
        prev.map(c =>
          c.label === 'Indexing files…'
            ? { ...c, status: 'error', detail: e.message }
            : c
        )
      );
    }

    setResult(registered);
    setStep(4);
    setSubmitting(false);
  }

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
          justifyContent: 'space-between',
          flexShrink: 0
        }}
      >
        <span style={{ fontWeight: 500, fontSize: 12 }}>
          Add storage backend
        </span>
        <button
          onClick={onCancel}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--jp-ui-font-color2)',
            fontSize: 16,
            lineHeight: 1
          }}
        >
          ×
        </button>
      </div>

      {/* Step indicator */}
      <div
        style={{ display: 'flex', padding: '8px 10px', gap: 4, flexShrink: 0 }}
      >
        {[1, 2, 3, 4].map(s => (
          <React.Fragment key={s}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 500,
                  background:
                    s < step
                      ? '#EAF3DE'
                      : s === step
                        ? 'var(--jp-brand-color1)'
                        : 'var(--jp-layout-color2)',
                  color:
                    s < step
                      ? '#27500A'
                      : s === step
                        ? 'white'
                        : 'var(--jp-ui-font-color2)'
                }}
              >
                {s < step ? '✓' : s}
              </div>
              <span
                style={{
                  fontSize: 9,
                  color:
                    s === step
                      ? 'var(--jp-ui-font-color1)'
                      : 'var(--jp-ui-font-color2)',
                  whiteSpace: 'nowrap'
                }}
              >
                {stepLabel(s)}
              </span>
            </div>
            {s < 4 && (
              <div
                style={{
                  flex: 1,
                  height: 1,
                  background: 'var(--jp-border-color2)',
                  marginTop: 10,
                  alignSelf: 'flex-start'
                }}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Step content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
        {step === 1 && (
          <>
            <p
              style={{
                fontSize: 12,
                color: 'var(--jp-ui-font-color2)',
                marginBottom: 10
              }}
            >
              Choose the type of storage to connect.
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 6
              }}
            >
              {BACKEND_TYPES.map(b => (
                <button
                  key={b.type}
                  onClick={() => {
                    setBeType(b.type);
                    setName(BACKEND_LABELS[b.type]);
                  }}
                  style={{
                    padding: '10px 8px',
                    border: `1px solid ${beType === b.type ? 'var(--jp-brand-color1)' : 'var(--jp-border-color1)'}`,
                    borderRadius: 4,
                    background:
                      beType === b.type
                        ? 'var(--jp-brand-color4)'
                        : 'var(--jp-layout-color1)',
                    cursor: 'pointer',
                    textAlign: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3
                  }}
                >
                  <span style={{ fontSize: 18 }}>{b.icon}</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: 'var(--jp-ui-font-color1)'
                    }}
                  >
                    {BACKEND_LABELS[b.type]}
                  </span>
                  <span
                    style={{ fontSize: 10, color: 'var(--jp-ui-font-color2)' }}
                  >
                    {b.desc}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && beType && (
          <>
            <p
              style={{
                fontSize: 12,
                color: 'var(--jp-ui-font-color2)',
                marginBottom: 10
              }}
            >
              Configure your {BACKEND_LABELS[beType]} connection.
            </p>
            <FormField label="Display name">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                style={inputStyle}
              />
            </FormField>

            {beType === 'irods' && (
              <div
                style={{
                  padding: 12,
                  background: 'var(--jp-layout-color2)',
                  borderRadius: 4,
                  fontSize: 12,
                  color: 'var(--jp-ui-font-color2)',
                  lineHeight: 1.6
                }}
              >
                <strong style={{ color: 'var(--jp-ui-font-color1)' }}>
                  iRODS — coming soon
                </strong>
                <br />
                Direct iRODS access requires a custom fsspec adapter around
                python-irodsclient. This is on the roadmap but not yet
                implemented.
                <br />
                <br />
                <strong>Workaround:</strong> mount your iRODS collection locally
                via iRODS FUSE and register it as a Local backend.
              </div>
            )}

            {beType === 'gdrive' && (
              <div
                style={{
                  padding: 12,
                  background: 'var(--jp-layout-color2)',
                  borderRadius: 4,
                  fontSize: 12,
                  color: 'var(--jp-ui-font-color2)',
                  lineHeight: 1.6
                }}
              >
                <strong style={{ color: 'var(--jp-ui-font-color1)' }}>
                  Google Drive — coming soon
                </strong>
                <br />
                Google Drive requires an OAuth2 browser flow to obtain
                credentials. Designing this flow in JupyterLab is out of scope
                for the current implementation.
                <br />
                <br />
                <strong>Workaround:</strong> sync your Google Drive folder
                locally via Google Drive for Desktop and register it as a Local
                backend.
              </div>
            )}

            {beType === 'local' && (
              <>
                <FormField label="Directory path">
                  <input
                    value={rootPath}
                    onChange={e => setRootPath(e.target.value)}
                    placeholder="/Users/you/data or /home/you/data"
                    style={inputStyle}
                  />
                </FormField>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: 'var(--jp-ui-font-color2)',
                    lineHeight: 1.5
                  }}
                >
                  Enter a directory on your local machine. The vreFS extension
                  reads it directly — your files never leave your machine unless
                  you explicitly stage them for a workflow.
                </div>
              </>
            )}

            {beType === 's3' && (
              <>
                <FormField label="Endpoint URL">
                  <input
                    value={host}
                    onChange={e => setHost(e.target.value)}
                    placeholder="http://minio:9000 (internal) or https://s3.amazonaws.com"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Bucket / root path">
                  <input
                    value={s3Bucket}
                    onChange={e => setS3Bucket(e.target.value)}
                    placeholder="my-bucket or my-bucket/prefix"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Access key env var name">
                  <input
                    value={s3AccessKeyVar}
                    onChange={e => setS3AccessKeyVar(e.target.value)}
                    placeholder="VREFS_MINIO_ACCESS_KEY"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Secret key env var name">
                  <input
                    value={s3SecretKeyVar}
                    onChange={e => setS3SecretKeyVar(e.target.value)}
                    placeholder="VREFS_MINIO_SECRET_KEY"
                    style={inputStyle}
                  />
                </FormField>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: 'var(--jp-ui-font-color2)',
                    lineHeight: 1.5
                  }}
                >
                  Enter the names of environment variables set in
                  docker-compose.yml, not the actual credential values. The
                  backend resolves them at runtime.
                </div>
              </>
            )}

            {beType === 'github' && (
              <>
                <FormField label="Repository URL">
                  <input
                    value={host}
                    onChange={e => setHost(e.target.value)}
                    placeholder="https://github.com/org/repo"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Branch">
                  <input
                    value={rootPath}
                    onChange={e => setRootPath(e.target.value)}
                    placeholder="main"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Token env var name">
                  <input
                    value={githubTokenVar}
                    onChange={e => setGithubTokenVar(e.target.value)}
                    placeholder="VREFS_GITHUB_TOKEN (optional for public repos)"
                    style={inputStyle}
                  />
                </FormField>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: 'var(--jp-ui-font-color2)',
                    lineHeight: 1.5
                  }}
                >
                  GitHub is read-only. Leave the token field empty for public
                  repos. For private repos, set the env var in
                  docker-compose.yml.
                </div>
              </>
            )}

            {beType === 'webdav' && (
              <>
                <FormField label="Server URL">
                  <input
                    value={host}
                    onChange={e => setHost(e.target.value)}
                    placeholder="https://researchdrive.surfsara.nl/remote.php/dav/files/username"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Root path (optional)">
                  <input
                    value={rootPath}
                    onChange={e => setRootPath(e.target.value)}
                    placeholder="my-project/data"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Username env var name">
                  <input
                    value={webdavUsernameVar}
                    onChange={e => setWebdavUsernameVar(e.target.value)}
                    placeholder="VREFS_WEBDAV_USERNAME"
                    style={inputStyle}
                  />
                </FormField>
                <FormField label="Password env var name">
                  <input
                    value={webdavPasswordVar}
                    onChange={e => setWebdavPasswordVar(e.target.value)}
                    placeholder="VREFS_WEBDAV_PASSWORD"
                    style={inputStyle}
                  />
                </FormField>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: 'var(--jp-ui-font-color2)',
                    lineHeight: 1.5
                  }}
                >
                  For SURF Research Drive, use an app password from Research
                  Drive settings, not your SURF account password.
                </div>
              </>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <p
              style={{
                fontSize: 12,
                color: 'var(--jp-ui-font-color2)',
                marginBottom: 10
              }}
            >
              {submitting
                ? `Checking ${beType ? BACKEND_LABELS[beType] : ''}…`
                : checks.some(c => c.status === 'error')
                  ? 'Check failed. Go back and fix the path.'
                  : checks.length > 0
                    ? 'Check passed. Confirm to register.'
                    : `Testing connection to ${beType ? BACKEND_LABELS[beType] : ''}…`}
            </p>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                marginBottom: 14
              }}
            >
              {checks.map(c => (
                <div
                  key={c.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    background: 'var(--jp-layout-color2)',
                    borderRadius: 4
                  }}
                >
                  <CheckIcon status={c.status} />
                  <span
                    style={{
                      fontSize: 12,
                      color:
                        c.status === 'pending'
                          ? 'var(--jp-ui-font-color2)'
                          : 'var(--jp-ui-font-color1)'
                    }}
                  >
                    {c.label}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {step === 4 && result && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
              {result.name} connected
            </div>
            <p
              style={{
                fontSize: 12,
                color: 'var(--jp-ui-font-color2)',
                marginBottom: 14
              }}
            >
              Browse this backend to register datasets into your data lake.
            </p>
          </div>
        )}
      </div>

      {/* Navigation — inside scrollable area so Lumino widget receives events */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 8,
          borderTop: '1px solid var(--jp-border-color2)',
          display: 'flex',
          justifyContent: 'space-between'
        }}
      >
        {step < 4 ? (
          <>
            <button
              onClick={
                step === 1 ? onCancel : () => setStep(s => (s - 1) as Step)
              }
              disabled={submitting}
              style={{ ...btnSecondary, opacity: submitting ? 0.5 : 1 }}
            >
              {step === 1 ? 'Cancel' : '‹ Back'}
            </button>
            <button
              disabled={
                (step === 1 && !beType) ||
                (step === 2 &&
                  beType === 's3' &&
                  (!host || !s3Bucket || !s3AccessKeyVar || !s3SecretKeyVar)) ||
                (step === 2 && beType === 'github' && !host) ||
                (step === 2 &&
                  beType === 'webdav' &&
                  (!host || !webdavUsernameVar || !webdavPasswordVar)) ||
                (step === 2 &&
                  beType !== 'local' &&
                  beType !== 's3' &&
                  beType !== 'github' &&
                  beType !== 'webdav') ||
                (step === 3 && checks.some(c => c.status === 'error')) ||
                submitting
              }
              onClick={
                step === 1
                  ? () => setStep(2)
                  : step === 2
                    ? runTest
                    : step === 3
                      ? handleConfirm
                      : undefined
              }
              style={{
                ...btnPrimary,
                opacity:
                  (step === 1 && !beType) ||
                  (step === 3 && checks.some(c => c.status === 'error')) ||
                  submitting
                    ? 0.5
                    : 1
              }}
            >
              {step === 1
                ? 'Next ›'
                : step === 2
                  ? 'Test connection ›'
                  : submitting
                    ? '…'
                    : 'Register backend ›'}
            </button>
          </>
        ) : (
          <button onClick={onDone} style={{ ...btnPrimary, flex: 1 }}>
            View in my data lake
          </button>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 7px',
  border: '1px solid var(--jp-border-color1)',
  borderRadius: 4,
  fontSize: 12,
  background: 'var(--jp-layout-color1)',
  color: 'var(--jp-ui-font-color1)',
  boxSizing: 'border-box'
};

const btnPrimary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'var(--jp-brand-color1)',
  color: 'white',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12
};

const btnSecondary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'none',
  color: 'var(--jp-ui-font-color1)',
  border: '1px solid var(--jp-border-color1)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12
};

const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children
}) => (
  <div style={{ marginBottom: 8 }}>
    <label
      style={{
        display: 'block',
        fontSize: 11,
        color: 'var(--jp-ui-font-color2)',
        marginBottom: 3
      }}
    >
      {label}
    </label>
    {children}
  </div>
);

const StatBox: React.FC<{ value: string; label: string }> = ({
  value,
  label
}) => (
  <div
    style={{
      padding: '8px 14px',
      background: 'var(--jp-layout-color2)',
      borderRadius: 4,
      textAlign: 'center'
    }}
  >
    <div style={{ fontWeight: 500, fontSize: 18 }}>{value}</div>
    <div style={{ fontSize: 11, color: 'var(--jp-ui-font-color2)' }}>
      {label}
    </div>
  </div>
);

const CheckIcon: React.FC<{ status: CheckItem['status'] }> = ({ status }) => {
  if (status === 'ok') {
    return <span style={{ color: '#3B6D11', fontSize: 13 }}>✓</span>;
  }
  if (status === 'error') {
    return <span style={{ color: '#A32D2D', fontSize: 13 }}>✗</span>;
  }
  if (status === 'pending') {
    return (
      <span style={{ color: 'var(--jp-ui-font-color2)', fontSize: 13 }}>○</span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-block',
        width: 13,
        height: 13,
        border: '2px solid var(--jp-brand-color1)',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'vrefs-spin 0.8s linear infinite'
      }}
    />
  );
};

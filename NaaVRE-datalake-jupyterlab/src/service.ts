/**
 * VreFSService
 *
 * All communication with the vreFS backend goes through this class, using
 * the NaaVRE communicator pattern.
 *
 * ── HOW THE COMMUNICATOR PATTERN WORKS ──────────────────────────────────────
 * Every call is wrapped in a POST to the SAME path in every environment:
 *   POST /naavre-communicator/external-service
 * Body: { "query": { "method", "url", "headers", "data" } }
 * The communicator injects the researcher's auth token and forwards to the
 * vreFS backend at BACKEND_URL.
 *
 * This file has NO notion of "local" vs "production" — that distinction
 * lives entirely outside this package, in WHICH server extension happens to
 * be listening at that path:
 *   - In a real NaaVRE deployment: NaaVRE-communicator-jupyterlab (someone
 *     else's package, already installed in the base image, talks to real
 *     Keycloak).
 *   - Locally, for development only: the separate, throwaway
 *     local-communicator-stub package (not part of vreFS, lives in its own
 *     repo/directory, installed only on a developer's machine, injects a
 *     fake JWT instead of a real Keycloak token).
 * Swapping between them is a `pip install`/`pip uninstall` on the OTHER
 * package — nothing in vreFS, including this file, ever changes.
 *
 * The only thing that genuinely differs between local and production is
 * WHERE the vreFS backend itself is deployed — see BACKEND_URL below.
 *
 * ── COMPATIBILITY LAYER ──────────────────────────────────────────────────────
 * The exported types (StorageBackend, Dataset, DataLakeStatus,
 * RegisterBackendPayload, ProvenanceLink) and method names on VreFSService
 * intentionally match the ORIGINAL mock-based interface, so the existing
 * components (AddStorageWizard, DataLakePanel, DatasetDetailPanel,
 * FAIRChecklist, MetadataEditor, utils.ts) keep working unmodified.
 *
 * Underneath, every method talks to the real backend (see *Wire types below,
 * which match the actual Django REST Framework serializers exactly) and maps
 * the response into the legacy shape. Fields that don't exist on the real
 * backend at all (description, tags, domain, institutional) are handled
 * explicitly below — see the comments on _mapDatasetWireToLegacy and
 * _mapBackendWireToLegacy for exactly what's real vs. defaulted.
 */

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * The NaaVRE communicator endpoint — same relative path locally and in
 * production. The browser calls the Jupyter server it is already on
 * (localhost:8888), so there is no cross-origin request and no CORS.
 *
 * Locally: answered by local-communicator-stub (this package, installed
 * alongside NaaVRE-datalake-jupyterlab, registers the same path via its
 * own Tornado handler, injects a fake JWT).
 *
 * Production: answered by NaaVRE-communicator-jupyterlab (already in the
 * base NaaVRE JupyterLab image, injects the researcher's Keycloak token).
 *
 * Nothing in this file changes between local and production.
 */
const COMMUNICATOR_URL = '/naavre-communicator/external-service';

/** LOCAL DEV: docker-compose on localhost. PRODUCTION: deployed vreFS service URL. */
const BACKEND_URL = 'http://localhost:8000';

// Confirmed against app/storage_backends/serializers.py and
// app/datasets/serializers.py. Use these directly in any NEW code; the
// legacy types below are a compatibility shim for existing components only.

interface BackendWire {
  id: string;
  name: string;
  backend_type: 's3' | 'gdrive' | 'github' | 'webdav' | 'irods' | 'local';
  status: 'connected' | 'error' | 'syncing' | 'unreachable';
  endpoint_url: string;
  root_path: string;
  virtual_lab: string;
  dataset_count: number;
  total_size_bytes: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PIDWire {
  pid_type: 'internal' | 'doi' | 'handle';
  pid_value: string;
  resolver_url?: string;
}

interface FAIRScoreWire {
  f: number;
  a: number;
  i: number;
  r: number;
  total: number;
  criteria: Record<string, boolean>;
}

interface DatasetWire {
  id: string;
  owner_id: string;
  backend: string; // FK — dataset always belongs to a backend
  path: string;
  name: string;
  format: string;
  size_bytes: number | null;
  checksum_sha256: string;
  licence: string;
  status: 'public' | 'private';
  metadata?: Record<string, any>; // present on detail endpoint, omitted on list
  fair_score: FAIRScoreWire | Record<string, never>;
  bbox_geojson: unknown | null;
  crs: string;
  source_workflow_id: string;
  source_dataset_ids: string[];
  virtual_lab: string;
  pids: PIDWire[];
  version_count?: number; // present on detail endpoint, omitted on list
  created_at: string;
  updated_at: string;
}

interface DataLakeWire {
  id: string;
  published: boolean;
  title: string;
  description: string;
  public_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface StagedDataset {
  id: string;
  dataset: string;
  status: 'pending' | 'copying' | 'ready' | 'error';
  staged_bucket: string;
  staged_key: string;
  staging_path: string | null;
  expires_at: string | null;
  workflow_run_id: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

// ── Legacy types — kept identical to the original mock interface ────────────
// Existing components import these names directly; do not rename.

export interface StorageBackend {
  id: string;
  name: string;
  type: 'irods' | 'gdrive' | 'github' | 's3' | 'webdav' | 'ipfs' | 'local';
  status: 'connected' | 'error' | 'syncing';
  dataset_count: number;
  total_size: string;
  institutional: boolean;
  last_synced: string | null;
  root_path: string;
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  backend_id: string;
  path: string;
  format: string;
  size: string;
  tags: string[];
  domain: string;
  status: 'public' | 'private';
  pid: string | null;
  fair_score: { f: number; a: number; i: number; r: number };
  versions: number;
  modified: string;
  licence: string | null;
  provenance: ProvenanceLink | null;
  source_owner_id?: string; // set when loaded from a subscription
  source_dataset_ids?: string[]; // set when imported from another lake
}

export interface ProvenanceLink {
  source_type: 'workflow' | 'upload' | 'import';
  source_id: string;
  source_label: string;
  input_dataset_ids: string[];
}

export interface DataLakeStatus {
  published: boolean;
  public_url: string | null;
  public_dataset_count: number;
  total_dataset_count: number;
  backend_count: number;
  avg_fair_score: number;
}

export interface RegisterBackendPayload {
  name: string;
  type: StorageBackend['type'];
  credentials: Record<string, unknown>;
  root_path: string;
  endpoint_url?: string;
}

// ── Core communicator wrapper ─────────────────────────────────────────────────

async function _communicate<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown
): Promise<T> {
  const url = `${BACKEND_URL}${path}`;

  const response = await fetch(COMMUNICATOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { method, url, headers: {}, data: data ?? {} }
    })
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = await response.json();
      detail = err.detail || err.error || err.message || JSON.stringify(err);
    } catch {
      /* leave statusText */
    }
    throw new Error(`vreFS ${method} ${path} → ${response.status}: ${detail}`);
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }
  return response.json();
}

// ── Mapping helpers ────────────────────────────────────────────────────────────

function _humanSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

/**
 * Map a real DatasetWire (from the backend) to the legacy Dataset shape
 * the existing components expect.
 *
 * Real, backend-backed fields: id, name, backend_id, path, format, size,
 * status, pid (first PID — datasets currently have exactly one), fair_score
 * (f/a/i/r only — total/criteria dropped since legacy shape doesn't have
 * them), versions, modified, licence.
 *
 * Derived-from-metadata fields (real data, just nested): description comes
 * from metadata['dct:description'], tags from metadata['dcat:keyword'].
 * These are only populated if something wrote them into the JSONB — the
 * automatic metadata-extraction worker does NOT set either of these today
 * (it only sets format/byteSize/checksum/distribution), so until a
 * researcher edits them via MetadataEditor, both will be empty.
 *
 * provenance is reconstructed from source_workflow_id / source_dataset_ids,
 * which ARE real columns on Dataset — just not populated by anything yet
 * (no workflow-output registration flow exists). Will be null for every
 * dataset until that flow is built.
 *
 * domain has NO backing column on the Dataset model. It is stored in the
 * metadata JSONB under 'dcat:theme' (the DCAT-2 vocabulary term for
 * thematic classification). Empty string if not set.
 */
function _mapDatasetWireToLegacy(w: DatasetWire): Dataset {
  const metadata = w.metadata ?? {};
  const description =
    typeof metadata['dct:description'] === 'string'
      ? metadata['dct:description']
      : '';
  const tags = Array.isArray(metadata['dcat:keyword'])
    ? (metadata['dcat:keyword'] as string[])
    : [];
  const domain =
    typeof metadata['dcat:theme'] === 'string' ? metadata['dcat:theme'] : '';

  const fw = w.fair_score as FAIRScoreWire | Record<string, never>;
  const fair_score =
    'f' in fw
      ? { f: fw.f, a: fw.a, i: fw.i, r: fw.r }
      : { f: 0, a: 0, i: 0, r: 0 };

  const provenance: ProvenanceLink | null = w.source_workflow_id
    ? {
        source_type: 'workflow',
        source_id: w.source_workflow_id,
        source_label: w.source_workflow_id,
        input_dataset_ids: w.source_dataset_ids ?? []
      }
    : null;

  return {
    id: w.id,
    name: w.name,
    description,
    backend_id: w.backend ?? '',
    path: w.path,
    format: w.format,
    size: _humanSize(w.size_bytes),
    tags,
    domain,
    status: w.status,
    pid: w.pids?.[0]?.pid_value ?? null,
    fair_score,
    versions: w.version_count ?? 0,
    modified: w.updated_at,
    licence: w.licence || null,
    provenance,
    source_dataset_ids: w.source_dataset_ids?.length
      ? w.source_dataset_ids
      : undefined
  };
}

/**
 * Map a real BackendWire to the legacy StorageBackend shape.
 *
 * Real fields: id, name, type, dataset_count, total_size (formatted from
 * total_size_bytes), last_synced (from last_synced_at) — all genuinely
 * tracked by the backend (dataset_count/total_size_bytes are updated by the
 * background sync job, which isn't built yet, so both are currently 0 for
 * every backend; the field is real, the data just hasn't been populated by
 * anything yet).
 *
 * institutional has NO backing field on the backend at all. Always false
 * until a model field (or a naming convention on virtual_lab) is added.
 */
function _mapBackendWireToLegacy(w: BackendWire): StorageBackend {
  return {
    id: w.id,
    name: w.name,
    type: w.backend_type as StorageBackend['type'],
    status:
      w.status === 'unreachable'
        ? 'error'
        : (w.status as StorageBackend['status']),
    dataset_count: w.dataset_count,
    total_size: _humanSize(w.total_size_bytes),
    institutional: false,
    last_synced: w.last_synced_at,
    root_path: w.root_path
  };
}

// ── VreFSService ───────────────────────────────────────────────────────────────

export class VreFSService {
  /**
   * @deprecated baseUrl/mock parameters no longer apply — every call goes
   * through the communicator to the real backend. Kept as accepted-but-
   * ignored parameters so any existing `new VreFSService(...)` call site
   * still compiles.
   */
  constructor(_baseUrl?: string, _mock?: boolean) {}

  /** @deprecated Mock mode no longer exists. No-op kept for compatibility. */
  useMock(_enabled = true): void {}

  // ── Lake status ────────────────────────────────────────────────────────────

  /**
   * Aggregates lake + backends + datasets into the legacy status shape.
   * NOTE: public_dataset_count and avg_fair_score are computed only over
   * the first page of datasets returned by the list endpoint (DRF default
   * pagination). total_dataset_count uses the paginator's true count field,
   * so it's accurate even with many datasets — the other two aggregates
   * are not, until a dedicated backend aggregate endpoint exists.
   */
  async getLakeStatus(): Promise<DataLakeStatus> {
    const [lake, backendsPage, page] = await Promise.all([
      _communicate<DataLakeWire>('GET', '/api/v1/lake/'),
      _communicate<{ results: BackendWire[]; count: number } | BackendWire[]>(
        'GET',
        '/api/v1/storage-backends/'
      ),
      _communicate<{ results: DatasetWire[]; count: number } | DatasetWire[]>(
        'GET',
        '/api/v1/datasets/'
      )
    ]);

    const backends = Array.isArray(backendsPage)
      ? backendsPage
      : backendsPage.results;
    const datasets = Array.isArray(page) ? page : page.results;
    const totalCount = Array.isArray(page) ? page.length : page.count;
    const publicCount = datasets.filter(d => d.status !== 'private').length;
    const scored = datasets.filter(
      d => 'total' in (d.fair_score as FAIRScoreWire)
    );
    const avgFair = scored.length
      ? Math.round(
          scored.reduce(
            (sum, d) => sum + (d.fair_score as FAIRScoreWire).total,
            0
          ) / scored.length
        )
      : 0;

    return {
      published: lake.published,
      public_url: lake.public_url,
      public_dataset_count: publicCount,
      total_dataset_count: totalCount,
      backend_count: backends.length,
      avg_fair_score: avgFair
    };
  }

  // ── Backends ────────────────────────────────────────────────────────────────

  async getBackends(): Promise<StorageBackend[]> {
    const page = await _communicate<{ results: BackendWire[] } | BackendWire[]>(
      'GET',
      '/api/v1/storage-backends/'
    );
    const wire = Array.isArray(page) ? page : page.results;
    return wire.map(_mapBackendWireToLegacy);
  }

  /**
   * NOTE: endpoint_url is not part of RegisterBackendPayload (the wizard UI
   * doesn't currently collect it). The model field is blank=True so the
   * backend accepts its absence — but S3/WebDAV backends need a real
   * endpoint_url to actually connect. Until the wizard collects it,
   * non-local backends registered here will fail testBackend()/browse().
   */
  async registerBackend(
    payload: RegisterBackendPayload
  ): Promise<StorageBackend> {
    const wire = await _communicate<BackendWire>(
      'POST',
      '/api/v1/storage-backends/',
      {
        name: payload.name,
        backend_type: payload.type,
        root_path: payload.root_path,
        endpoint_url: payload.endpoint_url ?? '',
        credentials: payload.credentials
      }
    );
    return _mapBackendWireToLegacy(wire);
  }

  async indexRemoteBackend(
    backendId: string
  ): Promise<{ indexed: number; total: number; message: string }> {
    return _communicate('POST', `/api/v1/storage-backends/${backendId}/index/`);
  }

  async testBackend(
    backendId: string
  ): Promise<{ ok: boolean; latency_ms: number; message: string }> {
    const start = Date.now();
    try {
      const wire = await _communicate<{ status: string; message?: string }>(
        'POST',
        `/api/v1/storage-backends/${backendId}/test/`
      );
      return {
        ok: wire.status === 'connected',
        latency_ms: Date.now() - start,
        message: wire.message ?? 'Connection successful'
      };
    } catch (e) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        message: e instanceof Error ? e.message : 'Connection failed'
      };
    }
  }

  async deleteBackend(backendId: string): Promise<void> {
    return _communicate('DELETE', `/api/v1/storage-backends/${backendId}/`);
  }

  // ── Datasets ────────────────────────────────────────────────────────────────

  /**
   * The list endpoint is intentionally lightweight on the backend (no
   * metadata blob, no backend/source fields — see DatasetListSerializer)
   * but the legacy UI expects backend_id/description/tags/provenance on
   * every card. For this local demo we fetch each dataset's full detail
   * too (N+1) to populate them. At real scale, replace this with either a
   * wider list serializer or lazy detail-fetching in the UI.
   */
  async getDatasets(backendId?: string): Promise<Dataset[]> {
    const qs = backendId ? `?backend=${backendId}` : '';
    const page = await _communicate<
      { results: { id: string }[] } | { id: string }[]
    >('GET', `/api/v1/datasets/${qs}`);
    const items = Array.isArray(page) ? page : page.results;
    const details = await Promise.all(
      items.map(item =>
        _communicate<DatasetWire>('GET', `/api/v1/datasets/${item.id}/`)
      )
    );
    return details.map(_mapDatasetWireToLegacy);
  }

  async getDataset(datasetId: string): Promise<Dataset> {
    const wire = await _communicate<DatasetWire>(
      'GET',
      `/api/v1/datasets/${datasetId}/`
    );
    return _mapDatasetWireToLegacy(wire);
  }

  async createDataset(payload: {
    backend: string;
    path: string;
    name: string;
    licence?: string;
    status?: Dataset['status'];
  }): Promise<Dataset> {
    const wire = await _communicate<DatasetWire>(
      'POST',
      '/api/v1/datasets/',
      payload
    );
    return _mapDatasetWireToLegacy(wire);
  }

  /**
   * Fetches the current dataset first and merges changes into its metadata
   * client-side before sending a PATCH. This is necessary because PATCHing
   * `metadata` replaces the whole JSONB value — without merging first we'd
   * wipe out fields the extraction worker already wrote (format/checksum/
   * distribution/etc).
   *
   * meta.domain is silently ignored — no backend field exists for it yet
   * (see _mapDatasetWireToLegacy comment).
   */
  async updateDatasetMetadata(
    datasetId: string,
    meta: Partial<Dataset>
  ): Promise<Dataset> {
    const current = await _communicate<DatasetWire>(
      'GET',
      `/api/v1/datasets/${datasetId}/`
    );
    const mergedMetadata = { ...(current.metadata ?? {}) };

    if (meta.description !== undefined) {
      mergedMetadata['dct:description'] = meta.description;
    }
    if (meta.tags !== undefined) {
      mergedMetadata['dcat:keyword'] = meta.tags;
    }
    if (meta.domain !== undefined) {
      mergedMetadata['dcat:theme'] = meta.domain;
    }

    const payload: Record<string, unknown> = { metadata: mergedMetadata };
    if (meta.name !== undefined) {
      payload.name = meta.name;
    }
    if (meta.licence !== undefined) {
      payload.licence = meta.licence ?? '';
    }
    if (meta.status !== undefined) {
      payload.status = meta.status;
    }

    const updated = await _communicate<DatasetWire>(
      'PATCH',
      `/api/v1/datasets/${datasetId}/`,
      payload
    );
    return _mapDatasetWireToLegacy(updated);
  }

  /**
   * Patch the low-level metadata fields (format, size_bytes, checksum)
   * computed locally for a local backend dataset — bypassing the Celery
   * extraction task which can't access the researcher's filesystem.
   */
  async patchLocalFileMetadata(
    datasetId: string,
    meta: {
      format: string;
      size_bytes: number;
      checksum_sha256: string;
    }
  ): Promise<void> {
    await _communicate('PATCH', `/api/v1/datasets/${datasetId}/`, meta);
  }

  /**
   * The real backend mints an internal PID automatically at registration
   * (PID.mint_internal, called from DatasetViewSet.perform_create) — every
   * dataset already has one by the time it exists anywhere in the UI. There
   * is no backend endpoint to mint a PID after the fact, and DOI minting
   * is not implemented (PIDType.DOI exists as a vocabulary slot only).
   * This method is therefore an idempotent fetch, not a real mint.
   */
  async assignPID(
    datasetId: string,
    pidType: 'internal' | 'doi' = 'internal'
  ): Promise<{ pid: string }> {
    if (pidType === 'doi') {
      throw new Error(
        'DOI minting is not implemented in the backend — only internal PIDs exist.'
      );
    }
    const dataset = await this.getDataset(datasetId);
    if (!dataset.pid) {
      throw new Error(
        'Dataset has no PID — unexpected, since PIDs are minted automatically at registration.'
      );
    }
    return { pid: dataset.pid };
  }

  /**
   * Internal PIDs are literally "dl:{dataset.id}" (see PID.mint_internal),
   * so for that scheme we recover the dataset id directly and fetch the
   * full, owner-scoped Dataset via the normal authenticated endpoint.
   * (The public /pids/resolve/ endpoint returns a minimal DCAT-2 FDO
   * document, not this internal shape — intentionally a different,
   * public-safe representation. See resolvePidFdo() below for that.)
   */
  async resolvePID(pid: string): Promise<Dataset> {
    if (pid.startsWith('dl:')) {
      return this.getDataset(pid.slice(3));
    }
    throw new Error(
      `Cannot resolve non-internal PID "${pid}" to a Dataset — DOI/Handle reverse lookup isn't implemented.`
    );
  }

  // ── Publishing ──────────────────────────────────────────────────────────────

  async publishLake(published: boolean): Promise<DataLakeStatus> {
    await _communicate('PATCH', '/api/v1/lake/', { published });
    return this.getLakeStatus();
  }

  async deleteDataset(datasetId: string): Promise<void> {
    return _communicate('DELETE', `/api/v1/datasets/${datasetId}/`);
  }

  async publishDataset(
    datasetId: string,
    status: Dataset['status']
  ): Promise<Dataset> {
    const wire = await _communicate<DatasetWire>(
      'PATCH',
      `/api/v1/datasets/${datasetId}/`,
      { status }
    );
    return _mapDatasetWireToLegacy(wire);
  }

  async getDiscover(): Promise<
    Array<{
      lake: {
        owner_id: string;
        title: string;
        description: string;
        published: boolean;
      };
      datasets: Dataset[];
    }>
  > {
    const raw = await _communicate<any[]>('GET', '/api/v1/discover/');
    return raw.map(entry => ({
      lake: entry.lake,
      datasets: entry.datasets.map(_mapDatasetWireToLegacy)
    }));
  }

  async getSubscriptions(): Promise<
    Array<{ id: string; source_owner_id: string; created_at: string }>
  > {
    const result = await _communicate<any>('GET', '/api/v1/subscriptions/');
    return result.results ?? result;
  }

  async subscribe(sourceOwnerId: string): Promise<void> {
    await _communicate('POST', '/api/v1/subscriptions/', {
      source_owner_id: sourceOwnerId
    });
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    await _communicate('DELETE', `/api/v1/subscriptions/${subscriptionId}/`);
  }

  async getSubscribedDatasets(): Promise<Dataset[]> {
    const raw = await _communicate<DatasetWire[]>(
      'GET',
      '/api/v1/subscribed-datasets/'
    );
    return raw.map(w => ({
      ..._mapDatasetWireToLegacy(w),
      source_owner_id: w.owner_id // tag so UI knows this is from a subscription
    }));
  }

  async importDataset(datasetId: string): Promise<Dataset> {
    const wire = await _communicate<DatasetWire>(
      'POST',
      `/api/v1/datasets/${datasetId}/import/`
    );
    return _mapDatasetWireToLegacy(wire);
  }

  async getAccessLog(
    datasetId: string
  ): Promise<
    Array<{ accessor_id: string; access_type: string; accessed_at: string }>
  > {
    return _communicate('GET', `/api/v1/datasets/${datasetId}/access-log/`);
  }

  // ── New methods — match the real backend 1:1, not required by current
  //    components, use these for any new UI work instead of the legacy ones ──

  async createBackend(payload: {
    name: string;
    backend_type: BackendWire['backend_type'];
    endpoint_url: string;
    root_path: string;
    credentials: Record<string, unknown>;
  }): Promise<StorageBackend> {
    const wire = await _communicate<BackendWire>(
      'POST',
      '/api/v1/storage-backends/',
      payload
    );
    return _mapBackendWireToLegacy(wire);
  }

  /**
   * Browse a remote backend — goes through the communicator to Django.
   * For local backends, use browseLocalBackend() instead.
   */
  async browseBackend(backendId: string, path = ''): Promise<BrowseEntry[]> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    return _communicate(
      'GET',
      `/api/v1/storage-backends/${backendId}/browse/${qs}`
    );
  }

  /**
   * Recursively list all non-hidden files under a local directory.
   * Returns a flat list — the tree structure is derived client-side
   * from the file paths. Used for indexing and re-sync.
   */
  async listLocalFiles(rootPath: string): Promise<
    Array<{
      name: string;
      path: string;
      size: number;
      modified: number;
    }>
  > {
    const response = await fetch(
      `/vrefs/local/files?path=${encodeURIComponent(rootPath)}`
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Cannot list files at ${rootPath}`);
    }
    return response.json();
  }

  /**
   * Browse a local directory on the researcher's machine.
   * Goes through the Jupyter server's local filesystem handler
   * (/vrefs/local/browse) — NOT through the communicator — since the
   * Django backend cannot access the researcher's local filesystem.
   */
  async browseLocalBackend(
    rootPath: string,
    subPath = ''
  ): Promise<BrowseEntry[]> {
    const fullPath = subPath ? `${rootPath}/${subPath}` : rootPath;
    const response = await fetch(
      `/vrefs/local/browse?path=${encodeURIComponent(fullPath)}`
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Cannot browse ${fullPath}`);
    }
    return response.json();
  }

  /**
   * Get metadata (size, MIME type, checksum) for a local file.
   * Used when registering a local file as a dataset.
   */
  async getLocalFileMetadata(filePath: string): Promise<{
    name: string;
    path: string;
    size: number;
    format: string;
    checksum_sha256: string;
  }> {
    const response = await fetch(
      `/vrefs/local/metadata?path=${encodeURIComponent(filePath)}`
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Cannot read metadata for ${filePath}`);
    }
    return response.json();
  }

  /** Raw DCAT-2 JSON-LD FDO document from the public resolver — not mapped to Dataset. */
  async resolvePidFdo(pid: string): Promise<Record<string, unknown>> {
    return _communicate(
      'GET',
      `/api/v1/pids/resolve/${encodeURIComponent(pid)}/`
    );
  }

  /**
   * Request staging for a remote/MinIO dataset.
   * Goes through the communicator to Django's staging Celery task.
   * For local backend datasets, use requestLocalStaging() instead.
   */
  async requestStaging(
    datasetId: string,
    workflowRunId: string
  ): Promise<StagedDataset> {
    return _communicate('POST', '/api/v1/staging/', {
      dataset: datasetId,
      workflow_run_id: workflowRunId
    });
  }

  /**
   * Stage a local file by reading it from the researcher's filesystem
   * and uploading it to Django's MinIO staging bucket.
   *
   * Used for datasets registered from a local backend. The extension
   * reads the file (which Django cannot reach) and POSTs it to
   * Django's /api/v1/staging/upload/ endpoint. Django writes it to
   * MinIO and returns a StagedDataset with status='ready'.
   */
  async requestLocalStaging(
    datasetId: string,
    workflowRunId: string,
    localPath: string
  ): Promise<StagedDataset> {
    const response = await fetch('/vrefs/local/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: localPath,
        dataset_id: datasetId,
        workflow_run_id: workflowRunId
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Local staging failed');
    }
    return response.json();
  }

  async getStagingStatus(stagingId: string): Promise<StagedDataset> {
    return _communicate('GET', `/api/v1/staging/${stagingId}/`);
  }
}

export const service = new VreFSService();

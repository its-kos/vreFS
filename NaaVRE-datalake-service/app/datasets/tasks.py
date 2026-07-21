"""
app/datasets/tasks.py

Background task: extract metadata from a registered dataset file.

Called automatically from DatasetViewSet.perform_create() via .delay()
immediately after a dataset is registered. The researcher sees their
dataset in the catalogue right away; this task fills in the details
a few seconds later.

What gets extracted:
  - size_bytes     via fs.info() — no download needed
  - format         via python-magic on the first 2KB of the file
  - checksum_sha256 via full file read — necessary for integrity
  - metadata       DCAT-2 JSON-LD fields populated from the above

The metadata JSONField is the FDO record — once this task runs,
GET /api/v1/pids/resolve/{pid}/ returns a non-empty, meaningful
DCAT-2 document for the first time.
"""

import hashlib
import logging

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3, default_retry_delay=30)
def extract_metadata(self, dataset_id: str):
    """
    Celery task. Runs in the worker process after dataset registration.

    bind=True        — gives us access to `self` (the task instance)
                       so we can call self.retry() on transient errors
    max_retries=3    — retry up to 3 times on failure
    default_retry_delay=30 — wait 30 seconds between retries
    """

    # Import here, not at module level, to avoid Django app-loading
    # issues when Celery loads tasks before Django is fully initialised.
    from app.datasets.models import Dataset
    from app.storage_backends.adapters import get_filesystem

    logger.info(f'extract_metadata started for dataset {dataset_id}')

    # ── 1. Load the dataset ───────────────────────────────────────────
    try:
        dataset = Dataset.objects.select_related('backend').get(id=dataset_id)
    except Dataset.DoesNotExist:
        logger.error(f'extract_metadata: dataset {dataset_id} not found — skipping')
        return

    if dataset.backend is None:
        logger.warning(f'extract_metadata: dataset {dataset_id} has no backend — skipping')
        return

    # ── 2. Get the fsspec filesystem for this backend ─────────────────
    try:
        fs = get_filesystem(dataset.backend)
    except NotImplementedError as e:
        logger.warning(f'extract_metadata: unsupported backend for {dataset_id}: {e}')
        return
    except Exception as exc:
        logger.error(f'extract_metadata: could not get filesystem for {dataset_id}: {exc}')
        raise self.retry(exc=exc)

    path = dataset.path

    # ── 3. File size — via fs.info(), no download needed ─────────────
    try:
        info = fs.info(path)
        size_bytes = info.get('size') or info.get('Size') or 0
    except Exception as exc:
        logger.error(f'extract_metadata: fs.info() failed for {dataset_id}: {exc}')
        raise self.retry(exc=exc)

    # ── 4. MIME type — read first 2KB, run python-magic ──────────────
    detected_format = ''
    try:
        import magic
        header = _read_partial(fs, path, max_bytes=2048)
        if header:
            detected_format = magic.from_buffer(header, mime=True)
    except ImportError:
        logger.warning('python-magic not installed — skipping format detection')
    except Exception as e:
        logger.warning(f'extract_metadata: format detection failed for {dataset_id}: {e}')

    # ── 5. SHA-256 checksum — full file read ──────────────────────────
    checksum = ''
    try:
        checksum = _compute_sha256(fs, path)
    except Exception as e:
        logger.warning(f'extract_metadata: checksum failed for {dataset_id}: {e}')

    # ── 6. Build DCAT-2 metadata fields ──────────────────────────────
    # Merge into existing metadata rather than overwriting it —
    # the researcher may have manually set fields we should not clobber.
    metadata = dict(dataset.metadata) if dataset.metadata else {}

    metadata.setdefault('@context', {
        'dcat': 'http://www.w3.org/ns/dcat#',
        'dct':  'http://purl.org/dc/terms/',
        'spdx': 'http://spdx.org/rdf/terms#',
    })
    metadata.setdefault('@type', 'dcat:Dataset')

    # Always overwrite auto-extracted fields — they reflect current
    # ground truth, not researcher input.
    if size_bytes:
        metadata['dcat:byteSize'] = size_bytes
    if detected_format:
        metadata['dct:format'] = detected_format
    if checksum:
        metadata['spdx:checksum'] = {
            'spdx:algorithm': 'SHA256',
            'spdx:checksumValue': checksum,
        }

    # Access URL — the path as a backend-specific URI so the FDO
    # resolver can include a dcat:distribution block.
    access_url = _build_access_url(dataset)
    if access_url:
        metadata['dcat:distribution'] = [{
            '@type': 'dcat:Distribution',
            'dcat:accessURL': access_url,
            'dct:format': detected_format,
        }]

    # ── 7. Write everything back to the dataset record ────────────────
    dataset.size_bytes       = size_bytes or dataset.size_bytes
    dataset.format           = detected_format or dataset.format
    dataset.checksum_sha256  = checksum or dataset.checksum_sha256
    dataset.metadata         = metadata

    dataset.save(update_fields=[
        'size_bytes', 'format', 'checksum_sha256', 'metadata', 'updated_at'
    ])

    # ── 8. Compute FAIR score now that fields are populated ───────────
    from app.datasets.fair import compute_fair_score
    fair_score = compute_fair_score(dataset)
    dataset.fair_score = fair_score
    dataset.save(update_fields=['fair_score', 'updated_at'])

    logger.info(
        f'extract_metadata complete for {dataset_id}: '
        f'size={size_bytes}, format={detected_format}, '
        f'checksum={checksum[:8] if checksum else "none"}..., '
        f'fair_total={fair_score["total"]}'
    )


# ── Private helpers ───────────────────────────────────────────────────

def _read_partial(fs, path: str, max_bytes: int = 2048) -> bytes:
    """Read the first max_bytes of a file without downloading the whole thing."""
    with fs.open(path, 'rb') as f:
        return f.read(max_bytes)


def _compute_sha256(fs, path: str) -> str:
    """
    Stream the full file through SHA-256.

    Reads in 1MB chunks rather than loading the whole file into memory —
    important for large files where a full in-memory load would be impractical.
    """
    h = hashlib.sha256()
    chunk_size = 1024 * 1024  # 1 MB
    with fs.open(path, 'rb') as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _build_access_url(dataset) -> str:
    """
    Build a backend-specific access URL for the dataset path.
    Used to populate dcat:distribution.accessURL in the FDO record.
    """
    backend = dataset.backend
    if backend is None:
        return ''

    from app.storage_backends.models import BackendType

    if backend.backend_type == BackendType.S3:
        # s3://bucket/path/to/file.laz
        bucket = backend.root_path.strip('/')
        file_path = dataset.path.lstrip('/')
        return f's3://{bucket}/{file_path}'

    if backend.backend_type == BackendType.WEBDAV:
        # Full WebDAV URL
        base = backend.endpoint_url.rstrip('/')
        file_path = dataset.path.lstrip('/')
        return f'{base}/{file_path}'

    if backend.backend_type == BackendType.GITHUB:
        # https://github.com/{org}/{repo}/blob/main/{path}
        org_repo = backend.endpoint_url.strip('/')
        return f'https://github.com/{org_repo}/blob/main/{dataset.path}'

    # For other types return just the path — better than nothing
    return dataset.path
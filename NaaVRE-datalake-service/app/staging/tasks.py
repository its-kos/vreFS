"""
app/staging/tasks.py

Background task: stage a dataset to MinIO before workflow execution.

Three-way decision based on the meeting outcome:

  1. Native MinIO backend
     Dataset already lives on NaaVRE MinIO — workflow containers can
     mount it directly. No copy needed. status → READY immediately.

  2. Foreign backend, file within size limit
     Copy the file to MinIO tmp/data/ staging area.
     The 60-day retention policy applies (per NaaVRE team reply).
     status: PENDING → COPYING → READY

  3. Foreign backend, file over size limit
     Copying a multi-terabyte file silently would be wrong.
     Reject with a clear explanation.
     status → ERROR (with actionable message)

The size limit is configurable via S3_STAGING_MAX_SIZE_BYTES
(default 1 GB in production, 10 MB in local docker-compose for testing).
"""

import datetime
import logging
import os

from celery import shared_task
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3, default_retry_delay=30)
def stage_dataset(self, staged_dataset_id: str):
    """
    Celery task. Stages a dataset to MinIO for workflow use.
    Called from StagedDatasetViewSet.perform_create() via .delay().
    """
    from app.staging.models import StagedDataset, StagingStatus
    from app.storage_backends.adapters import (
        get_filesystem,
        get_staging_filesystem,
        is_native_minio,
    )

    logger.info(f'stage_dataset started for staged_dataset {staged_dataset_id}')

    # ── 1. Load the staged dataset record ────────────────────────────
    try:
        staged = StagedDataset.objects.select_related(
            'dataset__backend'
        ).get(id=staged_dataset_id)
    except StagedDataset.DoesNotExist:
        logger.error(f'stage_dataset: record {staged_dataset_id} not found')
        return

    dataset = staged.dataset
    backend = dataset.backend

    if backend is None:
        _fail(staged, 'Dataset has no connected backend.')
        return

    # ── 2. Decision: native MinIO → pass-through, no copy ────────────
    if is_native_minio(backend):
        logger.info(f'stage_dataset: {dataset.id} is on native MinIO — pass-through')
        staged.status       = StagingStatus.READY
        staged.staged_bucket = settings.S3_STAGING_BUCKET
        staged.staged_key    = dataset.path.lstrip('/')
        staged.expires_at    = _ttl()
        staged.save(update_fields=[
            'status', 'staged_bucket', 'staged_key', 'expires_at', 'updated_at'
        ])
        return

    # ── 3. Decision: size check ─────────────────────────────────────────
    # Use cached size_bytes if available; otherwise do a live fs.info()
    # so we don't blindly attempt to copy an unknown-size file.
    max_size = settings.S3_STAGING_MAX_SIZE_BYTES
    try:
        source_fs = get_filesystem(backend)
        actual_size = dataset.size_bytes
        if actual_size is None:
            info = source_fs.info(dataset.path)
            actual_size = info.get('size') or info.get('Size') or 0
    except Exception as exc:
        _fail(staged, f'Could not determine file size: {exc}')
        return

    if actual_size > max_size:
        logger.warning(
            f'stage_dataset: {dataset.id} is too large '
            f'({actual_size} bytes > {max_size} bytes limit)'
        )
        _fail(
            staged,
            f'Dataset is {_human_size(actual_size)}, which exceeds the '
            f'{_human_size(max_size)} staging limit. '
            f'Transfer it to NaaVRE MinIO storage first, then register it from there.'
        )
        return

    # ── 4. Decision: copy to MinIO staging ───────────────────────────
    staged.status = StagingStatus.COPYING
    staged.save(update_fields=['status', 'updated_at'])

    try:
        staging_fs = get_staging_filesystem()
        bucket     = settings.S3_STAGING_BUCKET
        filename   = os.path.basename(dataset.path.rstrip('/'))
        staged_key = f'tmp/data/{staged.id}/{filename}'
        dest_path  = f'{bucket}/{staged_key}'

        logger.info(f'stage_dataset: copying {dataset.path} → {dest_path}')

        # Stream file from source to MinIO in 1 MB chunks.
        # Using explicit streaming rather than fsspec.copy() to ensure
        # cross-filesystem compatibility regardless of backend type.
        with source_fs.open(dataset.path, 'rb') as src:
            with staging_fs.open(dest_path, 'wb') as dst:
                chunk_size = 1024 * 1024  # 1 MB
                while True:
                    chunk = src.read(chunk_size)
                    if not chunk:
                        break
                    dst.write(chunk)

        staged.status        = StagingStatus.READY
        staged.staged_bucket = bucket
        staged.staged_key    = staged_key
        staged.expires_at    = _ttl()
        staged.save(update_fields=[
            'status', 'staged_bucket', 'staged_key', 'expires_at', 'updated_at'
        ])

        logger.info(f'stage_dataset complete: {staged_key}')

    except NotImplementedError as e:
        _fail(staged, f'Backend type not yet supported for staging: {e}')

    except Exception as exc:
        logger.error(f'stage_dataset: copy failed for {staged_dataset_id}: {exc}')
        staged.status        = StagingStatus.ERROR
        staged.error_message = str(exc)
        staged.save(update_fields=['status', 'error_message', 'updated_at'])
        raise self.retry(exc=exc)


# ── Helpers ───────────────────────────────────────────────────────────

def _fail(staged, message: str):
    """Mark a staging record as errored with a clear message."""
    from app.staging.models import StagingStatus
    staged.status        = StagingStatus.ERROR
    staged.error_message = message
    staged.save(update_fields=['status', 'error_message', 'updated_at'])


def _ttl() -> datetime.datetime:
    """Return the expiry datetime based on the configured TTL."""
    return timezone.now() + datetime.timedelta(days=settings.S3_STAGING_TTL_DAYS)


def _human_size(size_bytes: int) -> str:
    """Format bytes as a human-readable string for error messages."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            return f'{size_bytes:.1f} {unit}'
        size_bytes /= 1024
    return f'{size_bytes:.1f} PB'
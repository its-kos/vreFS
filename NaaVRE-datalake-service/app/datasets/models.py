import uuid
from django.contrib.gis.db import models as gis_models
from django.db import models
from app.storage_backends.models import StorageBackend


class DatasetStatus(models.TextChoices):
    PRIVATE = 'private', 'Private'
    PUBLIC  = 'public',  'Public'


class Dataset(models.Model):
    """
    A metadata record describing one file or collection of files
    on a connected StorageBackend.

    vreFS never stores the actual data — only the metadata record
    and a pointer to where the data lives on the backend.

    FAIR Digital Object design
    --------------------------
    The 'metadata' JSONField stores a DCAT-2 JSON-LD document.
    This document IS the FDO metadata record. When the PID resolver
    endpoint receives a request for a PID, it returns this document
    directly. A machine can parse it without knowing anything about
    vreFS specifically.

    Example structure of the metadata field:
    {
      "@context": { "dcat": "...", "dct": "...", "spdx": "..." },
      "@type": "dcat:Dataset",
      "dct:title": "AHN3 LiDAR Netherlands",
      "dct:description": "...",
      "dct:identifier": "dl:abc123",
      "dct:license": "https://creativecommons.org/licenses/by/4.0/",
      "dcat:keyword": ["LiDAR", "ecology"],
      "dcat:byteSize": 4000000000,
      "spdx:checksum": {
        "spdx:algorithm": "SHA256",
        "spdx:checksumValue": "a3f..."
      },
      "dcat:distribution": [{
        "@type": "dcat:Distribution",
        "dcat:accessURL": "s3://bucket/data/AHN3_NL.laz",
        "dct:format": "application/vnd.las"
      }]
    }

    Top-level columns vs metadata JSONB
    ------------------------------------
    Fields like name, format, size_bytes, checksum_sha256, licence are
    stored both as top-level columns AND inside the metadata JSONB.
    The top-level columns exist purely for query performance — you cannot
    efficiently filter or sort by fields inside a JSONB blob.
    The metadata JSONB is the canonical DCAT-2 record.
    The two are kept in sync by the metadata extraction worker.

    Soft delete
    -----------
    Datasets are never hard-deleted once a PID has been assigned.
    Setting deleted_at marks the dataset as deleted but keeps the record
    so the PID continues to resolve (returning a tombstone response).
    This is required by the FAIR principles — identifiers must be persistent.
    """

    id       = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner_id = models.CharField(max_length=255, db_index=True)
    backend  = models.ForeignKey(
        StorageBackend,
        on_delete=models.CASCADE,
        null=False,
        blank=False,
        related_name='datasets'
    )

    # Location on the backend
    path = models.CharField(max_length=1024)

    # ── Top-level columns for fast querying ──────────────────────────────────
    # These are duplicated from the metadata JSONB for performance.
    # Always kept in sync with the JSONB by the metadata extraction worker.

    name            = models.CharField(max_length=512)
    format          = models.CharField(max_length=64,  blank=True)
    size_bytes      = models.BigIntegerField(null=True, blank=True)
    checksum_sha256 = models.CharField(max_length=64,  blank=True)
    licence         = models.CharField(max_length=255, blank=True)

    # ── DCAT-2 JSON-LD metadata record (the FDO metadata) ────────────────────
    metadata   = models.JSONField(default=dict, blank=True)

    # ── FAIR score ────────────────────────────────────────────────────────────
    # Computed by the FAIR assessor, cached here for filtering and display.
    # Shape: { "f": 80, "a": 60, "i": 40, "r": 70, "total": 63 }
    fair_score = models.JSONField(default=dict, blank=True)

    # ── Visibility ────────────────────────────────────────────────────────────
    status = models.CharField(
        max_length=20,
        choices=DatasetStatus.choices,
        default=DatasetStatus.PRIVATE
    )

    # ── Geospatial fields (optional) ─────────────────────────────────────────
    # Null for non-spatial datasets. PostGIS PolygonField for spatial ones
    # (GeoTIFF, LAS/LAZ point clouds, ecological survey shapefiles).
    bbox = gis_models.PolygonField(null=True, blank=True, srid=4326)
    crs  = models.CharField(max_length=64, blank=True)

    # ── Provenance ────────────────────────────────────────────────────────────
    # Links to the workflow run that produced this dataset (opt-in).
    # The researcher sets these manually when registering workflow output.
    source_workflow_id  = models.CharField(max_length=255, blank=True)
    source_dataset_ids  = models.JSONField(default=list, blank=True)

    # ── NaaVRE context ────────────────────────────────────────────────────────
    virtual_lab = models.CharField(max_length=255, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'vrefs_datasets'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['owner_id', 'status']),
            models.Index(fields=['backend']),
            models.Index(fields=['format']),
            models.Index(fields=['virtual_lab']),
        ]

    def __str__(self):
        return self.name

    @property
    def is_deleted(self):
        return self.deleted_at is not None


class DatasetVersion(models.Model):
    """
    Immutable snapshot of a dataset at a point in time.

    Created automatically when the sync worker detects the file
    on the backend has changed (different checksum).
    Can also be created manually by the researcher.
    """

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    dataset        = models.ForeignKey(Dataset, on_delete=models.CASCADE, related_name='versions')
    version_number = models.PositiveIntegerField()
    path           = models.CharField(max_length=1024)
    checksum_sha256 = models.CharField(max_length=64, blank=True)
    size_bytes     = models.BigIntegerField(null=True, blank=True)
    change_note    = models.TextField(blank=True)
    created_by     = models.CharField(max_length=255, blank=True)
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'vrefs_dataset_versions'
        ordering = ['-version_number']
        unique_together = [('dataset', 'version_number')]

    def __str__(self):
        return f'{self.dataset.name} v{self.version_number}'


class DataLake(models.Model):
    """
    The researcher's personal data lake.
    One per researcher. Controls whether the lake is publicly discoverable.

    Publishing the lake (published=True) gives it a public URL at
    GET /api/v1/lakes/{owner_id}/ and makes all public datasets in it
    discoverable by other researchers. Private datasets are never exposed
    regardless of the lake's published state.
    """

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner_id    = models.CharField(max_length=255, unique=True, db_index=True)
    published   = models.BooleanField(default=False)
    title       = models.CharField(max_length=255, blank=True)
    description = models.TextField(blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'vrefs_data_lakes'

    def __str__(self):
        return f'{self.owner_id} data lake'


class Subscription(models.Model):
    """
    A researcher's subscription to another researcher's published lake.

    When researcher B subscribes to researcher A's lake, researcher B
    can see all of A's public datasets in their catalogue (clearly labelled
    as from A's lake) and can import any of them into their own lake.

    Subscribing does not copy any data — it's a reference only.
    Unsubscribing removes the subscription; imported datasets are unaffected.
    """

    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    subscriber_id    = models.CharField(max_length=255, db_index=True)
    source_owner_id  = models.CharField(max_length=255, db_index=True)
    created_at       = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'vrefs_subscriptions'
        unique_together = [('subscriber_id', 'source_owner_id')]
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.subscriber_id} → {self.source_owner_id}'


class DatasetAccess(models.Model):
    """
    Audit log of access events for a dataset.

    Written automatically when:
    - GET /api/v1/datasets/{id}/access/ is called (vrefs.get() in a notebook)
    - A dataset is imported by another researcher

    The dataset owner can view this log to understand who is using their
    published data. Not used for access control — access is determined
    solely by Dataset.status and DataLake.published.
    """

    class AccessType(models.TextChoices):
        VIEW   = 'view',   'Viewed metadata'
        OPEN   = 'open',   'Opened via vrefs.get()'
        IMPORT = 'import', 'Imported into own lake'

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    dataset     = models.ForeignKey(Dataset, on_delete=models.CASCADE, related_name='access_log')
    accessor_id = models.CharField(max_length=255)
    access_type = models.CharField(max_length=20, choices=AccessType.choices)
    accessed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'vrefs_dataset_access'
        ordering = ['-accessed_at']
        indexes = [
            models.Index(fields=['dataset', 'accessed_at']),
            models.Index(fields=['accessor_id']),
        ]

    def __str__(self):
        return f'{self.accessor_id} {self.access_type} {self.dataset.name}'
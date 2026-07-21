import uuid
from django.db import models


class StagingStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    COPYING = 'copying', 'Copying'
    READY   = 'ready',   'Ready'
    EXPIRED = 'expired', 'Expired'
    ERROR   = 'error',   'Error'


class StagedDataset(models.Model):
    """
    A temporary copy of a dataset on MinIO, created for one workflow run.

    Why staging exists
    ------------------
    Workflow steps run as containers on Kubernetes. NaaVRE mounts MinIO
    to these containers as a filesystem (confirmed in team reply — see
    https://github.com/NaaVRE/NaaVRE/issues/38). The containers access
    data via file paths, not URLs.

    A dataset might live on Google Drive, GitHub, or WebDAV. Those backends
    cannot be mounted to a Kubernetes container. So vreFS copies the dataset
    to MinIO first (tmp/data/, 60-day retention per NaaVRE team reply).
    The workflow then accesses it as a normal mounted file path.

    Lifecycle
    ---------
    1. Researcher picks a dataset as workflow input
    2. vreFS creates a StagedDataset with status='pending'
    3. Celery worker copies the file to MinIO (status='copying' → 'ready')
    4. Frontend gets the MinIO path, substitutes it in the workflow definition
    5. Workflow runs against MinIO — no knowledge of original backend
    6. After expires_at (60 days), a cleanup job sets status='expired'
       and deletes the staged file from MinIO

    One staging record per workflow run
    ------------------------------------
    If the same dataset is used in two workflow runs, there are two
    StagedDataset records. This gives us a complete provenance trail —
    we know exactly which version of a dataset was used in which run.
    """

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    dataset        = models.ForeignKey(
        'datasets.Dataset',
        on_delete=models.CASCADE,
        related_name='staged_copies'
    )
    requested_by   = models.CharField(max_length=255)
    status         = models.CharField(
        max_length=20,
        choices=StagingStatus.choices,
        default=StagingStatus.PENDING
    )

    # Where the staged copy lives on MinIO (tmp/data/ per NaaVRE team reply)
    # PLACEHOLDER: bucket name confirmed as tmp/data by NaaVRE team.
    # Exact MinIO endpoint to confirm before production deployment.
    staged_bucket  = models.CharField(max_length=255, blank=True)
    staged_key     = models.CharField(max_length=1024, blank=True)

    # 60-day retention per NaaVRE data policy
    expires_at     = models.DateTimeField(null=True, blank=True)

    # Which workflow run requested this staging (for provenance)
    workflow_run_id = models.CharField(max_length=255, blank=True)

    # Which version of the dataset was staged (for reproducibility)
    dataset_version = models.PositiveIntegerField(null=True, blank=True)

    error_message  = models.TextField(blank=True)
    created_at     = models.DateTimeField(auto_now_add=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'vrefs_staged_datasets'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['dataset', 'status']),
            models.Index(fields=['expires_at']),
        ]

    def __str__(self):
        return f'Staged {self.dataset.name} ({self.status})'

    @property
    def staging_path(self):
        """The file path as seen by a workflow container — bucket/key format."""
        if self.staged_key and self.staged_bucket:
            return f'{self.staged_bucket}/{self.staged_key}'
        if self.staged_key:
            return self.staged_key
        return None
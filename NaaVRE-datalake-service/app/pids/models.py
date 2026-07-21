import uuid
from django.db import models


class PIDType(models.TextChoices):
    INTERNAL = 'internal', 'Internal (dl:)'
    DOI      = 'doi',      'DataCite DOI'
    HANDLE   = 'handle',   'Handle'


class PID(models.Model):
    """
    A persistent identifier for a dataset.

    Two-tier strategy
    -----------------
    Internal PID (dl:{uuid})
      Minted immediately on dataset registration.
      Free, instant, no external service needed.
      Used in notebooks: vrefs.get("dl:abc123")
      Resolves to the FDO metadata record at /api/v1/pids/resolve/dl:{uuid}

    DataCite DOI (10.xxxx/...)
      Minted when researcher explicitly publishes.
      Externally resolvable, citable in papers.
      Requires DataCite API credentials.

    Stability guarantee
    -------------------
    If a dataset moves to a different backend, only the Dataset record changes.
    The PID record is never updated. The resolver reads the current Dataset
    location at resolve time. This is what makes PIDs stable even when
    underlying storage changes — a core FDO requirement.

    Tombstone behaviour
    -------------------
    If a dataset is soft-deleted (deleted_at is set), the PID still resolves.
    The resolver returns a tombstone FDO record explaining the data is gone.
    PIDs are never deleted once issued — this is required by FAIR principle F1.
    """

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    dataset      = models.ForeignKey(
        'datasets.Dataset',
        on_delete=models.CASCADE,
        related_name='pids'
    )
    pid_type     = models.CharField(max_length=20, choices=PIDType.choices)
    pid_value    = models.CharField(max_length=512, unique=True)
    resolver_url = models.CharField(max_length=512, blank=True)
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'vrefs_pids'

    def __str__(self):
        return self.pid_value

    @classmethod
    def mint_internal(cls, dataset):
        """
        Mint an internal dl: PID for a dataset.
        Called automatically on dataset registration.
        """
        pid_value = f'dl:{dataset.id}'
        return cls.objects.create(
            dataset=dataset,
            pid_type=PIDType.INTERNAL,
            pid_value=pid_value,
            resolver_url=f'/api/v1/pids/resolve/{pid_value}',
        )
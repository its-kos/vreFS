import uuid
from django.db import models


class BackendType(models.TextChoices):
    S3     = 's3',     'S3 / MinIO'
    GDRIVE = 'gdrive', 'Google Drive'
    GITHUB = 'github', 'GitHub'
    WEBDAV = 'webdav', 'WebDAV'
    IRODS  = 'irods',  'iRODS'
    LOCAL  = 'local',  'Local filesystem'


class BackendStatus(models.TextChoices):
    CONNECTED   = 'connected',   'Connected'
    ERROR       = 'error',       'Error'
    SYNCING     = 'syncing',     'Syncing'
    UNREACHABLE = 'unreachable', 'Unreachable'


class StorageBackend(models.Model):
    """
    A connected external storage system.

    One researcher can have many backends. Each backend is a source
    of datasets in their personal data lake.

    Credentials note
    ----------------
    Credentials are stored directly in the 'credentials' JSONField for now.
    This is intentionally temporary. It exists so local development works
    without Kubernetes. When vreFS is deployed on NaaVRE, this field is
    replaced by 'credential_ref', a string referencing a Kubernetes Secret.
    The storage adapter layer reads from whichever field is populated.

    The credentials field structure varies by backend type:
      S3/MinIO : { "access_key": "...", "secret_key": "..." }
      WebDAV   : { "username": "...",   "password":   "..." }
      GitHub   : { "token": "..." }
      GDrive   : { "token": "..." }
      iRODS    : { "username": "...", "password": "...", "zone": "..." }
    """

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # Owner identified by Keycloak sub claim (stable UUID from JWT).
    # Not a ForeignKey to a User model —> identity lives in Keycloak.
    owner_id     = models.CharField(max_length=255, db_index=True)

    name         = models.CharField(max_length=255)
    backend_type = models.CharField(max_length=20, choices=BackendType.choices)
    status       = models.CharField(
        max_length=20,
        choices=BackendStatus.choices,
        default=BackendStatus.SYNCING
    )

    # Connection details -> non-sensitive, safe to store in the database
    endpoint_url = models.CharField(max_length=512, blank=True)
    root_path    = models.CharField(max_length=512, blank=True)

    # TEMPORARY: credentials stored directly for local development.
    # Replace with credential_ref (Kubernetes Secret reference) on NaaVRE deployment.
    credentials  = models.JSONField(default=dict, blank=True)

    # Virtual lab context —> matches the slug used in NaaVRE catalogue service
    virtual_lab  = models.CharField(max_length=255, blank=True)

    # Counts updated by the background sync job
    dataset_count    = models.PositiveIntegerField(default=0)
    total_size_bytes = models.BigIntegerField(default=0)

    last_synced_at = models.DateTimeField(null=True, blank=True)
    created_at     = models.DateTimeField(auto_now_add=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'vrefs_storage_backends'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.name} ({self.backend_type})'
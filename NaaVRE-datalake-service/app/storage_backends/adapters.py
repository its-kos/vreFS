"""
app/storage_backends/adapters.py

The storage adapter layer. This is the only place in vreFS that knows
how to talk to individual storage backends.

Every other component — metadata extractor, staging layer, catalogue API —
calls get_filesystem(backend) and gets back a standard fsspec filesystem
object. It then calls fs.ls(), fs.open(), fs.info() without knowing or
caring what backend is underneath.

This is the fsspec pattern used by Pangeo, Intake, and the broader
Python scientific ecosystem. Reference:
  https://filesystem-spec.readthedocs.io/en/latest/

Supported backends
------------------
  S3 / MinIO   — via s3fs (primary NaaVRE backend)
  WebDAV       — via webdav4 (SURF Research Drive)
  GitHub       — via fsspec built-in github implementation
  Google Drive — via gdrivefs (stub, credentials flow TBD)
  iRODS        — via python-irodsclient custom wrapper (stub)
  Local        — via fsspec built-in local filesystem (dev only)

Credential handling
-------------------
Credentials are stored in backend.credentials (JSONField) as a
provider reference, not as raw values. The structure is:

    { "provider": "<name>", "<provider-specific fields>": ... }

get_credentials() dispatches to the appropriate provider function
based on the "provider" field. Everything else in vreFS calls
get_credentials() and never reads backend.credentials directly —
so adding a new credential provider, or swapping the implementation
of an existing one, requires changing only this section.

Implemented providers
---------------------
  none  — no credentials required (local filesystem, dev only)
  env   — resolves named environment variables at runtime.
          The DB stores variable names, not values. In local dev,
          set the vars in docker-compose. In Kubernetes, inject
          them from Secrets. In Vault, replace _resolve_env()
          with a call to the Vault API without changing anything
          else.

Stub providers (interface defined, not implemented)
---------------------------------------------------
  vault — HashiCorp Vault. The interface is defined so this can
          be implemented by replacing _resolve_vault() without
          touching get_credentials() or any call site.
          See: https://developer.hashicorp.com/vault/docs/secrets/kv
"""

import logging
import os
from typing import Any

import fsspec
import s3fs

from app.storage_backends.models import BackendType, StorageBackend

logger = logging.getLogger(__name__)


# ── Credential providers ──────────────────────────────────────────────────────

def _resolve_none(ref: dict) -> dict:
    """
    No credentials required.
    Used for local filesystem backends and any backend that
    authenticates via another mechanism (e.g. OAuth token already
    embedded in the endpoint URL).
    """
    return {}


def _resolve_env(ref: dict) -> dict:
    """
    Resolve credential values from environment variables.

    ref format:
        {
          "provider": "env",
          "vars": {
            "access_key": "VREFS_S3_ACCESS_KEY",
            "secret_key": "VREFS_S3_SECRET_KEY"
          }
        }

    The "vars" dict maps credential field names to environment
    variable names. At runtime, each variable name is replaced
    with its value from os.environ.

    LIMITATION: environment variables are process-wide and must
    be set before the service starts. This is acceptable for local
    development and Kubernetes (where Secrets are injected as env
    vars), but does not support per-user or per-request credential
    isolation. For that, replace this function with _resolve_vault().

    IN PRODUCTION (Kubernetes):
    Store secrets as K8s Secrets, mount them as env vars in the
    service pod. No change to this function or any call site.

    FUTURE (Vault):
    Replace this function with _resolve_vault(). The interface —
    takes a ref dict, returns a plain dict of resolved values —
    stays identical.
    """
    var_map = ref.get('vars', {})
    resolved = {}
    missing = []

    for field_name, env_var in var_map.items():
        value = os.environ.get(env_var)
        if value is None:
            missing.append(env_var)
        else:
            resolved[field_name] = value

    if missing:
        raise EnvironmentError(
            f'Missing environment variables for backend credentials: '
            f'{", ".join(missing)}. '
            f'Set these in docker-compose.yml (local) or as K8s Secret '
            f'env vars (production).'
        )

    return resolved


def _resolve_vault(ref: dict) -> dict:
    """
    Retrieve credentials from HashiCorp Vault.

    STUB — not implemented. The interface is defined here so this
    provider can be added without changing get_credentials() or
    any call site in the rest of vreFS.

    ref format (proposed):
        {
          "provider": "vault",
          "path": "secret/vrefs/backends/<backend_id>",
          "keys": ["access_key", "secret_key"]
        }

    To implement:
        1. pip install hvac
        2. Set VAULT_ADDR and VAULT_TOKEN in the environment
        3. Replace the raise below with:
               import hvac
               client = hvac.Client(url=os.environ['VAULT_ADDR'],
                                    token=os.environ['VAULT_TOKEN'])
               secret = client.secrets.kv.read_secret_version(
                            path=ref['path'])
               return {k: secret['data']['data'][k]
                       for k in ref.get('keys', [])}

    See: https://developer.hashicorp.com/vault/docs/secrets/kv
    """
    raise NotImplementedError(
        'Vault credential provider is not yet implemented. '
        'See _resolve_vault() in adapters.py for the implementation guide. '
        'As a workaround, use provider="env" with Vault Agent injecting '
        'the resolved values as environment variables.'
    )


# ── Credential retrieval — the single public interface ────────────────────────

_PROVIDERS = {
    'none':  _resolve_none,
    'env':   _resolve_env,
    'vault': _resolve_vault,
}


def get_credentials(backend: StorageBackend) -> dict:
    """
    Retrieve resolved credentials for a backend.

    Dispatches to the appropriate provider based on the 'provider'
    field in backend.credentials. Returns a plain dict of resolved
    credential values ready for use by the filesystem factories below.

    This is the ONLY function in vreFS that reads backend.credentials.
    Every other component calls this function and works with the
    resolved dict — so swapping credential providers is transparent
    to all call sites.

    Adding a new provider:
        1. Write a _resolve_<name>() function with the same signature
           (takes a ref dict, returns a resolved dict)
        2. Add it to _PROVIDERS above
        That's it. Nothing else needs to change.
    """
    ref = backend.credentials or {}
    provider_name = ref.get('provider', 'none')

    provider_fn = _PROVIDERS.get(provider_name)
    if provider_fn is None:
        raise ValueError(
            f'Unknown credential provider "{provider_name}". '
            f'Supported providers: {list(_PROVIDERS.keys())}'
        )

    return provider_fn(ref)


# ── Filesystem factory ────────────────────────────────────────────────────────

def get_filesystem(backend: StorageBackend) -> fsspec.AbstractFileSystem:
    """
    Returns a configured fsspec filesystem for the given backend.
    This is the only function the rest of vreFS calls.

    Usage:
        fs = get_filesystem(backend)
        files = fs.ls(backend.root_path)
        with fs.open('path/to/file.csv') as f:
            data = f.read()
    """
    creds = get_credentials(backend)

    if backend.backend_type == BackendType.S3:
        return _s3_filesystem(backend, creds)

    if backend.backend_type == BackendType.WEBDAV:
        return _webdav_filesystem(backend, creds)

    if backend.backend_type == BackendType.GITHUB:
        return _github_filesystem(backend, creds)

    if backend.backend_type == BackendType.GDRIVE:
        return _gdrive_filesystem(backend, creds)

    if backend.backend_type == BackendType.IRODS:
        return _irods_filesystem(backend, creds)

    if backend.backend_type == BackendType.LOCAL:
        return fsspec.filesystem('file')

    raise ValueError(f'Unsupported backend type: {backend.backend_type}')


# ── Per-backend implementations ───────────────────────────────────────────────

def _s3_filesystem(backend: StorageBackend, creds: dict) -> s3fs.S3FileSystem:
    """
    S3 / MinIO filesystem.

    Credentials expected:
        { "access_key": "...", "secret_key": "..." }

    Works with any S3-compatible endpoint — AWS S3, MinIO, Ceph S3.
    The NaaVRE infrastructure uses MinIO over Ceph.

    endpoint_url distinguishes MinIO from AWS S3.
    If endpoint_url is empty, falls back to AWS S3.
    """
    kwargs = {
        'key': creds.get('access_key', ''),
        'secret': creds.get('secret_key', ''),
    }
    if backend.endpoint_url:
        kwargs['endpoint_url'] = backend.endpoint_url
        kwargs['client_kwargs'] = {'endpoint_url': backend.endpoint_url}

    return s3fs.S3FileSystem(**kwargs)


def _webdav_filesystem(backend: StorageBackend, creds: dict):
    """
    WebDAV filesystem — SURF Research Drive and similar.

    Credentials expected:
        { "username": "...", "password": "..." }

    Uses webdav4, which implements the fsspec AbstractFileSystem
    interface over WebDAV. Supports SURF Research Drive (Nextcloud)
    and any standard WebDAV endpoint.

    Note on SURF app passwords:
    Credentials use an app password generated in Research Drive settings,
    not the researcher's main SURF password. App passwords are scoped
    to WebDAV access and can be revoked independently.
    """
    from webdav4.fsspec import WebdavFileSystem

    return WebdavFileSystem(
        base_url=backend.endpoint_url,
        auth=(creds.get('username', ''), creds.get('password', '')),
    )


def _github_filesystem(backend: StorageBackend, creds: dict):
    """
    GitHub repository filesystem.

    Credentials expected:
        { "token": "ghp_..." }

    endpoint_url stores the full GitHub URL or "org/repo".
    root_path stores the branch name (default: "main").

    The branch is passed as the sha parameter to fsspec's GitHub
    filesystem so fs.find('') lists all files at that branch.

    Read-only — fsspec's GitHub filesystem does not support writes.
    """
    url = backend.endpoint_url.strip('/')
    if url.startswith('https://github.com/'):
        org_repo = url.replace('https://github.com/', '').strip('/')
    else:
        org_repo = url

    parts = org_repo.split('/')
    if len(parts) < 2:
        raise ValueError(
            f'GitHub URL must be "https://github.com/org/repo" '
            f'or "org/repo", got: {url}'
        )

    token = creds.get('token', '') or None
    kwargs = dict(
        org=parts[0],
        repo=parts[1],
        sha=backend.root_path or 'main',
    )
    if token:
        kwargs['token'] = token
        kwargs['username'] = parts[0]

    return fsspec.filesystem('github', **kwargs)


def _gdrive_filesystem(backend: StorageBackend, creds: dict):
    """
    Google Drive filesystem.

    STUB — Google Drive OAuth2 flow requires browser interaction to
    obtain initial credentials. The exact flow depends on whether we
    use a service account (for shared lab drives) or user OAuth2
    (for personal drives). To be implemented once the OAuth2 flow
    in the JupyterLab extension is designed.

    Credentials expected (TBD):
        { "token": "...", "refresh_token": "..." }
    """
    raise NotImplementedError(
        'Google Drive adapter not yet implemented. '
        'Requires OAuth2 flow design — see GitHub issue TBD.'
    )


def _irods_filesystem(backend: StorageBackend, creds: dict):
    """
    iRODS filesystem — SURF iRODS and similar.

    STUB — iRODS does not have a native fsspec implementation.
    We wrap python-irodsclient in a custom fsspec AbstractFileSystem
    subclass. The wrapper is a separate class that will be implemented
    once we have access to a test iRODS instance to validate against.

    Credentials expected:
        { "username": "...", "password": "...", "zone": "..." }
    """
    raise NotImplementedError(
        'iRODS adapter not yet implemented. '
        'Requires access to a test iRODS instance for validation.'
    )


# ── Utility functions ─────────────────────────────────────────────────────────

def test_connection(backend: StorageBackend) -> tuple[bool, str]:
    """
    Test whether a backend is reachable and credentials are valid.

    Returns (True, '') on success.
    Returns (False, error_message) on failure.

    Called by the background task after a researcher registers a backend.
    The result updates StorageBackend.status.
    """
    try:
        fs = get_filesystem(backend)
        # GitHub: branch is baked into the filesystem constructor.
        # List from repo root, not root_path (which is the branch name).
        if backend.backend_type == BackendType.GITHUB:
            path = ''
        else:
            path = backend.root_path or ''
        fs.ls(path)
        return True, ''
    except NotImplementedError as e:
        return False, str(e)
    except Exception as e:
        logger.warning(f'Connection test failed for backend {backend.id}: {e}')
        return False, str(e)


def list_files(backend: StorageBackend, path: str = '') -> list[dict]:
    """
    List files and folders at the given path on a backend.
    Returns a list of dicts with: name, path, size, type, modified.

    Used by the UI to let the researcher browse and select datasets.
    Path defaults to backend.root_path if not specified.
    """
    fs = get_filesystem(backend)
    target = path or backend.root_path or ''

    try:
        entries = fs.ls(target, detail=True)
    except FileNotFoundError:
        return []

    results = []
    for entry in entries:
        results.append({
            'name': entry.get('name', '').split('/')[-1],
            'path': entry.get('name', ''),
            'size': entry.get('size', 0),
            'type': entry.get('type', 'file'),
            'modified': entry.get('LastModified') or entry.get('mtime', ''),
        })
    return results


def find_all_files(backend: StorageBackend) -> list[dict]:
    """
    Recursively find all files under backend.root_path.
    Returns a list of dicts with: path, size, modified.

    Used by the initial indexing job when a backend is first connected,
    and by the periodic sync job to detect new or changed files.

    Only returns files, not directories.
    """
    fs = get_filesystem(backend)
    # GitHub: branch is baked into the filesystem constructor (sha param).
    # The path root is always '' (repo root). For all other backends,
    # root_path is the filesystem path to start from.
    if backend.backend_type == BackendType.GITHUB:
        root = ''
    else:
        root = backend.root_path or ''

    try:
        all_entries = fs.find(root, detail=True)
    except Exception as e:
        logger.error(f'find_all_files failed for backend {backend.id}: {e}')
        return []

    files = []
    for path, info in all_entries.items():
        if info.get('type', 'file') == 'file':
            files.append({
                'path': path,
                'size': info.get('size', 0),
                'modified': info.get('LastModified') or info.get('mtime', ''),
            })
    return files


def read_file_bytes(backend: StorageBackend, path: str, max_bytes: int = None):
    """
    Open a file on a backend and return its contents.

    max_bytes: if set, only read this many bytes (used by metadata
    extractor to read file headers without downloading the whole file).
    """
    fs = get_filesystem(backend)
    with fs.open(path, 'rb') as f:
        if max_bytes:
            return f.read(max_bytes)
        return f.read()


def copy_to_staging(
    backend: StorageBackend,
    source_path: str,
    staging_fs,
    staging_path: str,
) -> None:
    """
    Copy a file from a backend to the MinIO staging filesystem.

    source_path  : path on the source backend
    staging_fs   : an s3fs filesystem pointed at the staging MinIO
    staging_path : destination path on MinIO (e.g. tmp/data/{id}/file.laz)

    Uses fsspec.copy() which handles the stream between any two filesystems
    without loading the whole file into memory — important for large files.
    """
    source_fs = get_filesystem(backend)
    fsspec.copy(
        f'{source_path}',
        f'{staging_path}',
        source_fs,
        staging_fs,
    )


def is_native_minio(backend: StorageBackend) -> bool:
    """
    Return True if this backend is the NaaVRE-native MinIO instance.

    When a dataset already lives on NaaVRE MinIO, staging is a no-op —
    the workflow container can already mount and read it directly.
    We detect this by matching the backend endpoint URL against
    the configured staging endpoint.
    """
    from django.conf import settings

    if backend.backend_type != BackendType.S3:
        return False

    backend_endpoint = (backend.endpoint_url or '').rstrip('/')
    staging_endpoint = settings.S3_STAGING_ENDPOINT.rstrip('/')
    return backend_endpoint == staging_endpoint


def get_staging_filesystem():
    """
    Return an s3fs filesystem pointed at the MinIO staging bucket.
    Used by the staging Celery task to write staged copies.
    """
    from django.conf import settings
    import s3fs

    return s3fs.S3FileSystem(
        key=settings.S3_STAGING_ACCESS_KEY,
        secret=settings.S3_STAGING_SECRET_KEY,
        endpoint_url=settings.S3_STAGING_ENDPOINT,
        client_kwargs={'endpoint_url': settings.S3_STAGING_ENDPOINT},
    )


def get_access_info(backend: StorageBackend, dataset_path: str) -> dict:
    """
    Return the fsspec URL and storage_options needed to open a dataset.

    This is the single place where backend type and credentials are
    translated into a protocol-agnostic (url, storage_options) pair that
    the vrefs Python client can pass directly to fsspec.open().

    Credentials are resolved here via get_credentials() — the client
    receives actual values, never credential references. This is acceptable
    for a single-researcher VRE where the researcher owns the data and the
    credentials. In a multi-tenant production system, replace the returned
    values with presigned URLs or temporary STS credentials so raw secrets
    never leave the server.

    Returns
    -------
    dict with keys:
        protocol      : fsspec protocol string (informational)
        url           : full fsspec-compatible URL
        storage_options : kwargs to pass to fsspec.open()
    """
    credentials = get_credentials(backend)
    t = backend.backend_type

    if t == BackendType.LOCAL:
        # File lives on the researcher's machine. The notebook also runs
        # there, so a plain file:// URL is sufficient.
        return {
            'protocol': 'file',
            'url': f'file://{dataset_path}',
            'storage_options': {},
        }

    elif t == BackendType.S3:
        # s3fs paths include the bucket name (e.g. "my-bucket/key/file.csv").
        # find_all_files returns full paths including the bucket, so we just
        # build the URL directly from dataset_path if it already starts with
        # root_path. Otherwise prepend root_path.
        root = backend.root_path.rstrip('/')
        path = dataset_path.lstrip('/')
        if root and path.startswith(root + '/'):
            # path already includes bucket — use as-is
            url = f's3://{path}'
        else:
            url = f's3://{root}/{path}' if root else f's3://{path}'

        # The internal endpoint (e.g. http://minio:9000) is used by Django
        # inside Docker. The vrefs client runs on the researcher's machine
        # and needs the public endpoint (e.g. http://localhost:9000).
        # VREFS_S3_PUBLIC_ENDPOINT overrides the stored endpoint for the
        # access info returned to the client. In production this would be
        # the publicly reachable MinIO/S3 URL.
        public_endpoint = (
            os.environ.get('VREFS_S3_PUBLIC_ENDPOINT')
            or backend.endpoint_url
            or None
        )

        return {
            'protocol': 's3',
            'url': url,
            'storage_options': {
                'endpoint_url': public_endpoint,
                'key': credentials.get('access_key', '') or None,
                'secret': credentials.get('secret_key', '') or None,
                'anon': not credentials.get('access_key'),
            },
        }

    elif t == BackendType.WEBDAV:
        # Return base_url and credentials separately so the vrefs client
        # can construct a webdav4 filesystem directly. fsspec's HTTP
        # filesystem doesn't handle WebDAV auth correctly.
        base = backend.endpoint_url.rstrip('/')
        root = backend.root_path.strip('/') if backend.root_path else ''
        path = dataset_path.lstrip('/')
        full_path = f'{root}/{path}' if root else path
        return {
            'protocol': 'webdav',
            'url': f'{base}/{full_path}',
            'storage_options': {
                'base_url': base,
                'username': credentials.get('username', ''),
                'password': credentials.get('password', ''),
            },
        }

    elif t == BackendType.GITHUB:
        # endpoint_url = "https://github.com/org/repo" or "org/repo"
        # root_path = branch name
        url = backend.endpoint_url.strip('/')
        org_repo = url.replace('https://github.com/', '') if url.startswith('https://github.com/') else url
        parts = org_repo.split('/', 1)
        org = parts[0]
        repo = parts[1] if len(parts) > 1 else ''
        branch = backend.root_path or 'main'
        path = dataset_path.lstrip('/')
        token = credentials.get('token', '') or None
        fsspec_url = f'github://{org}:{repo}@{branch}/{path}'
        storage_options = {}
        if token:
            storage_options['token'] = token
            storage_options['username'] = org
        return {
            'protocol': 'github',
            'url': fsspec_url,
            'storage_options': storage_options,
        }

    elif t == BackendType.IRODS:
        # iRODS support via irods:// fsspec protocol.
        # Adapter not yet fully implemented — staging is the fallback.
        raise NotImplementedError(
            f'iRODS direct notebook access is not yet implemented. '
            f'Stage the dataset first using the vreFS panel and use '
            f'the staging path with s3fs instead.'
        )

    elif t == BackendType.GDRIVE:
        raise NotImplementedError(
            f'Google Drive direct notebook access is not yet implemented. '
            f'Stage the dataset first using the vreFS panel and use '
            f'the staging path with s3fs instead.'
        )

    else:
        raise NotImplementedError(
            f'Backend type "{t}" does not have a notebook access '
            f'implementation. Stage the dataset first using the vreFS panel.'
        )
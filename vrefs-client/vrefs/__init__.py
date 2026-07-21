"""
vrefs — notebook client for the vreFS personal data lake.

Usage
-----
    import vrefs
    ds = vrefs.get("dl:bda10c98-...")   # returns a file handle
    data = ds.read()

    # As a context manager
    with vrefs.get("dl:bda10c98-...") as f:
        df = pandas.read_csv(f)

    # Binary or text mode
    with vrefs.get("dl:bda10c98-...", mode="r") as f:
        text = f.read()

Configuration
-------------
By default the client connects to a local vreFS backend:

    VREFS_API_URL  — base URL of the vreFS service (default: http://localhost:8000)
    VREFS_TOKEN    — bearer token (default: local dev fake JWT)

In a NaaVRE deployment, the platform injects these as environment
variables so the researcher's notebook code requires no changes.

How it works
------------
vrefs.get() calls GET /api/v1/datasets/{id}/access/ on the vreFS
backend. The backend resolves credentials server-side and returns:

    { "url": "s3://bucket/path/file.csv", "storage_options": { ... } }

vrefs.get() passes this to fsspec.open(). fsspec handles every
protocol — local, S3, WebDAV, GitHub, iRODS — with the same call.
The notebook code is identical regardless of where the data lives.

Supported backends
------------------
  local   -> file:// (file on the researcher's machine)
  s3      -> s3://  (S3-compatible: AWS, MinIO, Ceph)
  webdav  -> http:// with auth (SURF Research Drive, Nextcloud)
  github  -> github:// (public or private repos)
  irods   -> stage first; direct access not yet implemented
  gdrive  -> stage first; direct access not yet implemented
"""

import os
import fsspec
import requests

# ── Configuration ─────────────────────────────────────────────────────────────

_API_URL = os.environ.get('VREFS_API_URL', 'http://localhost:8000')

_TOKEN = os.environ.get(
    'VREFS_TOKEN',
    # Local dev default — fake JWT accepted when DISABLE_AUTH=true.
    # In production, VREFS_TOKEN is injected by the NaaVRE platform.
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    '.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJ0ZXN0dXNlciIsImdyb3VwcyI6W119'
    '.vMyx0jYENWe-YDHlZir84bxDhcL2Se6y_WQHG3Dvl5c'
)

# ── Internal ──────────────────────────────────────────────────────────────────

def _headers() -> dict:
    return {'Authorization': f'Bearer {_TOKEN}'}


def _resolve(pid: str) -> tuple:
    """
    Resolve a PID to (protocol, url, storage_options) via the vreFS access endpoint.
    The backend handles all credential resolution server-side.
    """
    if not pid.startswith('dl:'):
        raise ValueError(
            f"Unknown PID format: '{pid}'. "
            "vreFS internal PIDs start with 'dl:' followed by a UUID."
        )

    dataset_id = pid[3:]

    try:
        resp = requests.get(
            f'{_API_URL}/api/v1/datasets/{dataset_id}/access/',
            headers=_headers(),
            timeout=10,
        )
    except requests.ConnectionError:
        raise ConnectionError(
            f"Could not connect to vreFS at {_API_URL}. "
            "Make sure the backend is running (docker-compose up)."
        )

    if resp.status_code == 404:
        raise LookupError(
            f"Dataset '{pid}' not found. "
            "Check the PID and make sure you are the dataset owner."
        )

    if not resp.ok:
        try:
            detail = resp.json().get('error', resp.text)
        except Exception:
            detail = resp.text
        raise RuntimeError(f"vreFS access error ({resp.status_code}): {detail}")

    data = resp.json()
    return data.get('protocol', ''), data['url'], data.get('storage_options', {})


# ── Public API ────────────────────────────────────────────────────────────────

def get(pid: str, mode: str = 'rb'):
    """
    Resolve a vreFS PID and return an open file handle.

    The handle is backend-agnostic — it behaves like a regular Python
    file object regardless of whether the data lives on a local
    filesystem, S3, WebDAV, or any other supported backend.

    Parameters
    ----------
    pid : str
        A vreFS persistent identifier, e.g. 'dl:bda10c98-...'
        Copy it from the dataset detail panel in the vreFS JupyterLab extension.
    mode : str
        File open mode. Default 'rb' (binary read). Use 'r' for text.

    Returns
    -------
    File-like object (fsspec AbstractBufferedFile).

    Examples
    --------
    >>> import vrefs
    >>> with vrefs.get("dl:bda10c98-...") as f:
    ...     data = f.read()

    >>> import pandas as pd
    >>> df = pd.read_csv(vrefs.get("dl:bda10c98-...", mode="r"))
    """
    protocol, url, storage_options = _resolve(pid)

    if protocol == 'webdav':
        # WebDAV: use webdav4 directly since fsspec's HTTP filesystem
        # doesn't handle WebDAV auth correctly.
        try:
            from webdav4.fsspec import WebdavFileSystem
        except ImportError:
            raise ImportError(
                "webdav4 is required for WebDAV backends: "
                "pip install 'webdav4[fsspec]'"
            )
        from urllib.parse import urlparse
        fs = WebdavFileSystem(
            storage_options.get('base_url', url),
            auth=(
                storage_options.get('username', ''),
                storage_options.get('password', ''),
            ),
        )
        # path is everything after the base_url
        base = storage_options.get('base_url', '').rstrip('/')
        path = url[len(base):] if url.startswith(base) else urlparse(url).path
        return fs.open(path, mode)

    return fsspec.open(url, mode, **storage_options).open()


def info(pid: str) -> dict:
    """
    Return the full dataset metadata record without opening the file.

    >>> vrefs.info("dl:bda10c98-...")
    {'name': 'test.txt', 'format': 'text/plain', 'size_bytes': 42, ...}
    """
    if not pid.startswith('dl:'):
        raise ValueError(f"Unknown PID format: '{pid}'")

    dataset_id = pid[3:]
    resp = requests.get(
        f'{_API_URL}/api/v1/datasets/{dataset_id}/',
        headers=_headers(),
        timeout=10,
    )
    if resp.status_code == 404:
        raise LookupError(f"Dataset '{pid}' not found.")
    resp.raise_for_status()
    return resp.json()
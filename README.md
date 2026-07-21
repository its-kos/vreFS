# vreFS: A Personal Data Lake for NaaVRE

vreFS is a personal, FAIR-aware data lake for researchers working in
[NaaVRE](https://github.com/NaaVRE) (Notebook-as-a-VRE). It catalogues a
researcher's data wherever it already lives, across local storage, S3-compatible
object stores, GitHub repositories, and (planned) WebDAV, iRODS, and Google
Drive, without requiring the data to be migrated into a new system. Every
registered dataset receives FAIR-oriented metadata and a persistent identifier
automatically, and can be accessed uniformly from a notebook with a single
function call, regardless of which backend it actually lives on.

This repository contains the full working prototype developed as part of an
MSc thesis: *vreFS: A Personal Data Lake for NaaVRE* (Konstantinos Katserelis,
Vrije Universiteit Amsterdam / University of Amsterdam).

## Components

| Component | Description |
|---|---|
| `NaaVRE-datalake-service` | The backend: a Django REST Framework service exposing the catalogue API, FAIR scoring, PID minting, and backend adapters. |
| `NaaVRE-datalake-jupyterlab` | The frontend: a JupyterLab panel extension for registering backends, browsing datasets, editing metadata, and discovering/subscribing to other researchers' published lakes. |
| `vrefs-client` | A small Python package for accessing datasets directly from a notebook cell (`vrefs.get(pid)`, `vrefs.info(pid)`). |
| `local-communicator-stub` | A local development stand-in for NaaVRE's own communicator extension, injecting a fake JWT so the frontend can be exercised without a real NaaVRE deployment. Not used in production. |

## Architecture

vreFS runs inside a NaaVRE Virtual Lab, using PostgreSQL/PostGIS, MinIO,
Celery, and Keycloak already provided by that platform. The design and
implementation are documented in full in the accompanying thesis; the
short version:

- **Client layer** — the JupyterLab panel (routed through NaaVRE's
  communicator) and the `vrefs` notebook client (calling the REST API
  directly) are two independent, equally valid ways to reach the same
  catalogue.
- **Service layer** — a Django REST API tracking datasets, computing FAIR
  scores, minting PIDs, and abstracting over heterogeneous storage backends
  via `fsspec`.
- **Infrastructure layer** — provided by the NaaVRE platform (PostgreSQL,
  MinIO, Keycloak); not something vreFS itself manages.

## Getting started (local development)

Local development uses `docker-compose` to stand in for a real NaaVRE
Virtual Lab, since one was not available during this project.
`DISABLE_AUTH=true` accepts a fixed fake JWT instead of a real
Keycloak-issued token.

### 1. Start the backend

```bash
cd NaaVRE-datalake-service
cp .env.example .env   # defaults are fine for local development
docker-compose up
```

This starts four containers: PostgreSQL/PostGIS, Redis, MinIO, and the
Django service (on `localhost:8000`).

In a second terminal, run migrations once:

```bash
docker-compose exec service python manage.py migrate
```

### 2. Start the frontend

```bash
cd NaaVRE-datalake-jupyterlab
jlpm run watch      # terminal 1 — auto-recompiles on save
jupyter lab          # terminal 2 — opens JupyterLab
```

The vreFS panel appears in JupyterLab's left sidebar.

### 3. Install the notebook client

```bash
pip install -e ./vrefs-client
```

```python
import vrefs
f = vrefs.get("dl:your-dataset-uuid")
```

## Current implementation status

Supported storage backends: **Local, S3/MinIO, and GitHub** are implemented
and tested end-to-end. **WebDAV** is implemented and code-reviewed but has
not been validated against a live server (no test credentials were
available). **iRODS** and **Google Drive** are designed for but not yet
implemented.

Several parts of the full proposed design remain specified but not yet
built in this prototype, including DataCite DOI minting, delegated
cross-researcher authorization for a true independent file copy on import,
Vault-based credential management, and size-aware workflow staging. These
gaps, and the reasoning behind them, are documented in full in the thesis's
Limitations chapter.

## License

See [LICENSE](./LICENSE).

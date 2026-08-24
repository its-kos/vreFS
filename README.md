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
MSc thesis: *vreFS: A Personal Data Lake for NaaVRE*

## Components

| Component                    | Description                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NaaVRE-datalake-service`    | The backend: a Django REST Framework service exposing the catalogue API, FAIR scoring, PID minting, and backend adapters.                                                             |
| `NaaVRE-datalake-jupyterlab` | The frontend: a JupyterLab panel extension for registering backends, browsing datasets, editing metadata, and discovering/subscribing to other researchers' published lakes.          |
| `vrefs-client`               | A small Python package for accessing datasets directly from a notebook cell (`vrefs.get(pid)`, `vrefs.info(pid)`).                                                                    |
| `local-communicator-stub`    | A local development stand-in for NaaVRE's own communicator extension, injecting a fake JWT so the frontend can be exercised without a real NaaVRE deployment. Not used in production. |

## Architecture

This vreFS mock runs inside a NaaVRE Virtual Lab simulated docker compose instance, using PostgreSQL/PostGIS, MinIO,
Celery, and Keycloak already provided by that platform. The design and implementation are documented in full in the accompanying thesis.

- **Client layer** — the JupyterLab panel (routed through NaaVRE's
  communicator) and the `vrefs` notebook client (calling the REST API
  directly) are two independent, equally valid ways to reach the same
  catalogue.
- **Service layer** — a Django REST API tracking datasets, computing FAIR
  scores, minting PIDs, and abstracting over heterogeneous storage backends
  via `fsspec`.
- **Infrastructure layer** — provided by the NaaVRE platform (PostgreSQL,
  MinIO, Keycloak). 

## Getting started (local development)

Local development uses `docker-compose` to stand in for a real NaaVRE
Virtual Lab, since one was not available during this project.
`DISABLE_AUTH=true` accepts a fixed fake JWT instead of a real
Keycloak-issued token.

Run `startup.sh`, included in this repository, to bring up the
entire local environment, conda environment, backend containers,
database readiness, the communicator stub, the frontend extension, the
notebook client, and JupyterLab itself:

```bash
cd NaaVRE-datalake-service
./startup.sh
```

Safe to re-run at any point, every step checks current state first and
skips work already done. Override the repo location if the four
component repos aren't cloned as siblings under the same parent
directory:

```bash
VREFS_ROOT=/path/to/parent/dir ./startup.sh
```

### Testing specific flows

See `NaaVRE-datalake-service/scripts/` for ready-to-run scripts
covering multi-backend registration and the full
publish/discover/subscribe/import collaboration flow between two
simulated researcher identities, useful for demonstrating or
re-verifying specific behaviour without going through the UI by hand.

### Tearing down

See `NaaVRE-datalake-service/teardown.sh` for a full, safe reset,
containers, volumes, built images, and (optionally) the conda
environment itself, useful before testing a genuinely from-scratch
setup.

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
"""
Seed script — simulates 2 other researchers with published data lakes.

Run with:
    docker-compose exec service python manage.py shell < seed_discover.py

Creates:
  - researcher-alice  — ecology datasets on local backend
  - researcher-bob    — climate datasets on S3 backend

Both lakes are published and their public datasets are discoverable.
The current test-user can subscribe and browse them via the Discover view.
"""

from app.datasets.models import Dataset, DatasetStatus, DataLake
from app.storage_backends.models import StorageBackend, BackendType, BackendStatus
from app.pids.models import PID


# ── Researcher Alice ───────────────────────────────────────────────────────────

alice_backend, _ = StorageBackend.objects.get_or_create(
    owner_id='researcher-alice',
    name='Alice Local Data',
    defaults=dict(
        backend_type=BackendType.LOCAL,
        root_path='/data/alice',
        status=BackendStatus.CONNECTED,
        credentials={'provider': 'none'},
    )
)

alice_datasets = [
    dict(
        name='bird_survey_2024.csv',
        path='/data/alice/bird_survey_2024.csv',
        format='text/csv',
        size_bytes=48200,
        checksum_sha256='a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f600',
        status=DatasetStatus.PUBLIC,
        metadata={
            'dct:description': 'Annual bird species survey across the Netherlands, 2024.',
            'dcat:keyword': ['ecology', 'birds', 'biodiversity', 'netherlands'],
            'dcat:theme': 'Ecology',
        },
        licence='CC BY 4.0',
        fair_score={'f': 100, 'a': 0, 'i': 100, 'r': 100, 'total': 75},
    ),
    dict(
        name='vegetation_map.geojson',
        path='/data/alice/vegetation_map.geojson',
        format='application/geo+json',
        size_bytes=2100000,
        checksum_sha256='b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6b200',
        status=DatasetStatus.PUBLIC,
        metadata={
            'dct:description': 'Vegetation coverage map derived from Sentinel-2 imagery.',
            'dcat:keyword': ['vegetation', 'remote-sensing', 'GIS'],
            'dcat:theme': 'Remote sensing',
        },
        licence='CC BY 4.0',
        fair_score={'f': 100, 'a': 0, 'i': 100, 'r': 100, 'total': 75},
    ),
    dict(
        name='soil_samples.csv',
        path='/data/alice/soil_samples.csv',
        format='text/csv',
        size_bytes=12400,
        checksum_sha256='c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6c300',
        status=DatasetStatus.PRIVATE,  # private — should NOT appear in discover
        metadata={'dct:description': 'Unpublished soil composition samples.'},
        licence='',
        fair_score={'f': 50, 'a': 0, 'i': 0, 'r': 0, 'total': 12},
    ),
]

for d in alice_datasets:
    dataset, created = Dataset.objects.get_or_create(
        owner_id='researcher-alice',
        backend=alice_backend,
        path=d['path'],
        defaults={k: v for k, v in d.items() if k != 'path'},
    )
    if created:
        PID.mint_internal(dataset)
        print(f'  Created: {dataset.name} ({dataset.status})')
    else:
        print(f'  Exists:  {dataset.name}')

alice_lake, _ = DataLake.objects.update_or_create(
    owner_id='researcher-alice',
    defaults=dict(
        published=True,
        title="Alice's Ecology Lake",
        description='Ecology and biodiversity datasets from the Netherlands Ecology Institute.',
    )
)
print(f'Alice lake published: {alice_lake.published}')


# ── Researcher Bob ─────────────────────────────────────────────────────────────

bob_backend, _ = StorageBackend.objects.get_or_create(
    owner_id='researcher-bob',
    name='Bob MinIO',
    defaults=dict(
        backend_type=BackendType.S3,
        endpoint_url='http://minio:9000',
        root_path='vrefs-staging',
        status=BackendStatus.CONNECTED,
        credentials={'provider': 'env', 'vars': {'access_key': 'VREFS_MINIO_ACCESS_KEY', 'secret_key': 'VREFS_MINIO_SECRET_KEY'}},
    )
)

bob_datasets = [
    dict(
        name='temperature_anomalies_1950_2024.csv',
        path='vrefs-staging/bob/temperature_anomalies_1950_2024.csv',
        format='text/csv',
        size_bytes=892000,
        checksum_sha256='d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6d400',
        status=DatasetStatus.PUBLIC,
        metadata={
            'dct:description': 'Global surface temperature anomalies 1950–2024 from ERA5 reanalysis.',
            'dcat:keyword': ['climate', 'temperature', 'ERA5', 'reanalysis'],
            'dcat:theme': 'Climate science',
        },
        licence='CC BY 4.0',
        fair_score={'f': 100, 'a': 100, 'i': 100, 'r': 100, 'total': 100},
    ),
    dict(
        name='precipitation_nl_2023.nc',
        path='vrefs-staging/bob/precipitation_nl_2023.nc',
        format='application/x-netcdf',
        size_bytes=45000000,
        checksum_sha256='e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6e500',
        status=DatasetStatus.PUBLIC,
        metadata={
            'dct:description': 'Daily precipitation measurements across the Netherlands, 2023.',
            'dcat:keyword': ['precipitation', 'hydrology', 'netherlands', '2023'],
            'dcat:theme': 'Hydrology',
        },
        licence='CC BY 4.0',
        fair_score={'f': 100, 'a': 100, 'i': 100, 'r': 100, 'total': 100},
    ),
]

for d in bob_datasets:
    dataset, created = Dataset.objects.get_or_create(
        owner_id='researcher-bob',
        backend=bob_backend,
        path=d['path'],
        defaults={k: v for k, v in d.items() if k != 'path'},
    )
    if created:
        PID.mint_internal(dataset)
        print(f'  Created: {dataset.name} ({dataset.status})')
    else:
        print(f'  Exists:  {dataset.name}')

bob_lake, _ = DataLake.objects.update_or_create(
    owner_id='researcher-bob',
    defaults=dict(
        published=True,
        title="Bob's Climate Data",
        description='Climate reanalysis and observational datasets for the Netherlands.',
    )
)
print(f'Bob lake published: {bob_lake.published}')

print('\nDone. Open the Discover view in vreFS to see these lakes.')
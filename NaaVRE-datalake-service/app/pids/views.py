from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status

from .models import PID


class PIDResolveView(APIView):
    """
    GET /api/v1/pids/resolve/{pid}/

    Public endpoint — no authentication required.
    Accepts both internal PIDs (dl:{uuid}) and DataCite DOIs.

    Returns the DCAT-2 JSON-LD FDO metadata record for the dataset.
    This endpoint IS the FAIR Digital Object resolver — a machine can
    dereference any vreFS PID and get back structured, machine-readable
    metadata without knowing anything about vreFS specifically.

    If the dataset has been soft-deleted, returns a tombstone (HTTP 410).
    PIDs are permanent — they resolve forever even after deletion.
    This satisfies FAIR principle F1 (persistent identifiers).
    """
    permission_classes = [AllowAny]

    def get(self, request, pid):
        try:
            pid_obj = PID.objects.select_related('dataset').get(pid_value=pid)
        except PID.DoesNotExist:
            return Response(
                {'error': 'PID not found'},
                status=status.HTTP_404_NOT_FOUND,
            )

        dataset = pid_obj.dataset

        # Tombstone response for deleted datasets.
        # HTTP 410 Gone signals the resource existed but is no longer available.
        if dataset.is_deleted:
            return Response(
                {
                    '@type': 'Tombstone',
                    'dct:identifier': pid,
                    'dct:title': dataset.name,
                    'dct:description': 'This dataset has been removed by its owner.',
                    'schema:dateDeleted': dataset.deleted_at.isoformat(),
                },
                status=status.HTTP_410_GONE,
            )

        # Return the FDO record — the dataset's DCAT-2 JSON-LD metadata.
        # Inject the PID and resolver URL if not already present.
        fdo = dict(dataset.metadata) if dataset.metadata else {}
        fdo.setdefault('@context', {
            'dcat': 'http://www.w3.org/ns/dcat#',
            'dct':  'http://purl.org/dc/terms/',
            'spdx': 'http://spdx.org/rdf/terms#',
        })
        fdo.setdefault('@type', 'dcat:Dataset')
        fdo['dct:identifier'] = pid
        fdo['dct:title']      = dataset.name

        return Response(fdo)
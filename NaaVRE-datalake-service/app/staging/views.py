import logging
import os

from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser

from .models import StagedDataset
from .serializers import StagedDatasetSerializer
from .tasks import stage_dataset
from app.datasets.models import Dataset
from app.storage_backends.adapters import get_staging_filesystem

logger = logging.getLogger(__name__)


class StagedDatasetViewSet(
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    """
    POST /api/v1/staging/          — request staging for a remote/MinIO dataset
    GET  /api/v1/staging/{id}/     — check staging status
    POST /api/v1/staging/upload/   — upload a local file directly (local backend path)

    Remote backends: Django's Celery task copies the file from the remote
    storage to the staging MinIO bucket.

    Local backends: the vreFS JupyterLab extension reads the file from the
    researcher's machine and POSTs it here. Django saves it to MinIO and
    marks the record as ready immediately — no Celery task needed.

    The two paths produce the same StagedDataset output shape, so the
    workflow consumer doesn't need to know which path was used.
    """
    serializer_class = StagedDatasetSerializer

    def get_queryset(self):
        return StagedDataset.objects.filter(
            requested_by=self.request.user.sub
        )

    def perform_create(self, serializer):
        staged = serializer.save(requested_by=self.request.user.sub)
        stage_dataset.delay(str(staged.id))
        logger.info(f'Staging requested for dataset {staged.dataset_id}')

    @action(
        detail=False,
        methods=['post'],
        url_path='upload',
        parser_classes=[MultiPartParser],
    )
    def upload(self, request):
        """
        POST /api/v1/staging/upload/

        Called by the vreFS JupyterLab extension for local backend datasets.
        The extension reads the file from the researcher's filesystem and
        POSTs it here as multipart/form-data.

        Required fields:
            file            — the file bytes
            dataset_id      — UUID of the Dataset record
            workflow_run_id — workflow run this staging is for (may be empty)

        Saves the file to the MinIO staging bucket and returns a
        StagedDataset record with status='ready'.
        """
        file = request.FILES.get('file')
        dataset_id = request.data.get('dataset_id', '')
        workflow_run_id = request.data.get('workflow_run_id', '')

        if not file or not dataset_id:
            return Response({'error': 'file and dataset_id are required'}, status=400)

        try:
            dataset = Dataset.objects.get(
                id=dataset_id,
                owner_id=request.user.sub
            )
        except Dataset.DoesNotExist:
            return Response({'error': 'Dataset not found'}, status=404)

        # Create the staged record immediately
        staged = StagedDataset.objects.create(
            dataset=dataset,
            workflow_run_id=workflow_run_id,
            requested_by=request.user.sub,
            status='copying',
        )

        # Upload file to MinIO staging bucket
        try:
            fs = get_staging_filesystem()
            staging_key = f'tmp/data/{staged.id}/{file.name}'
            staging_bucket = os.environ.get('S3_STAGING_BUCKET', 'vrefs-staging')

            with fs.open(f'{staging_bucket}/{staging_key}', 'wb') as dest:
                for chunk in file.chunks():
                    dest.write(chunk)

            staged.staged_key = staging_key
            staged.staged_bucket = staging_bucket
            staged.status = 'ready'
            staged.save()

            logger.info(
                f'Local file staged: {file.name} → '
                f's3://{staging_bucket}/{staging_key}'
            )

        except Exception as e:
            staged.status = 'error'
            staged.error_message = str(e)
            staged.save()
            logger.error(f'Local staging failed for {file.name}: {e}')

        return Response(StagedDatasetSerializer(staged).data)
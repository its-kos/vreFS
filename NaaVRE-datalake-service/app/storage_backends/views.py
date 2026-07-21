import logging

from django.utils import timezone
from rest_framework import viewsets, mixins, status
from rest_framework.decorators import action
from rest_framework.response import Response

from .adapters import test_connection, list_files, find_all_files
from .models import StorageBackend, BackendStatus, BackendType
from .serializers import StorageBackendSerializer

logger = logging.getLogger(__name__)


class StorageBackendViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """
    Endpoints for managing connected storage backends.

    All queries are automatically scoped to the authenticated researcher
    via get_queryset() — a researcher can only see and manage their own backends.
    """
    serializer_class = StorageBackendSerializer

    def get_queryset(self):
        # Every query filtered by the researcher's Keycloak UUID.
        # request.user is a VreFSUser set by KeycloakAuthentication.
        return StorageBackend.objects.filter(owner_id=self.request.user.sub)

    def perform_create(self, serializer):
        # Attach the researcher's identity before saving.
        serializer.save(owner_id=self.request.user.sub)

    @action(detail=True, methods=['post'], url_path='test')
    def test(self, request, pk=None):
        """
        POST /api/v1/storage-backends/{id}/test/
        Test whether the backend is reachable with the stored credentials.
        Updates StorageBackend.status to 'connected' or 'error'.
        """
        backend = self.get_object()
        success, error_msg = test_connection(backend)

        if success:
            backend.status = BackendStatus.CONNECTED
            backend.save(update_fields=['status'])
            return Response({'status': 'connected'})
        else:
            backend.status = BackendStatus.ERROR
            backend.save(update_fields=['status'])
            return Response(
                {'status': 'error', 'message': error_msg},
                status=status.HTTP_400_BAD_REQUEST,
            )

    @action(detail=True, methods=['get'], url_path='browse')
    def browse(self, request, pk=None):
        """
        GET /api/v1/storage-backends/{id}/browse/?path=some/folder/
        List files and folders at the given path on the backend.
        Used by the frontend to let the researcher select a dataset to register.
        """
        backend = self.get_object()
        path = request.query_params.get('path', '')

        try:
            files = list_files(backend, path)
            return Response(files)
        except NotImplementedError as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_501_NOT_IMPLEMENTED,
            )
        except Exception as e:
            logger.error(f'Browse failed for backend {backend.id}: {e}')
            return Response(
                {'error': 'Could not list files', 'detail': str(e)},
                status=status.HTTP_400_BAD_REQUEST,
            )

    @action(detail=True, methods=['post'], url_path='index')
    def index(self, request, pk=None):
        """
        POST /api/v1/storage-backends/{id}/index/

        Recursively walk the backend and register every file as a Dataset.
        Uses get_or_create so re-indexing is idempotent — existing datasets
        are not duplicated.

        For remote backends (S3, WebDAV etc.) this runs server-side via
        fsspec so Django can read the files directly and the Celery metadata
        extraction task works normally.

        For local backends, indexing is handled by the JupyterLab extension
        (which can read the researcher's filesystem) — this endpoint is not
        called for local backends.

        Returns the count of newly registered datasets.
        """
        from app.datasets.models import Dataset
        from app.datasets.tasks import extract_metadata
        from app.pids.models import PID

        backend = self.get_object()

        try:
            files = find_all_files(backend)
        except NotImplementedError as e:
            return Response({'error': str(e)}, status=status.HTTP_501_NOT_IMPLEMENTED)
        except Exception as e:
            logger.error(f'Index failed for backend {backend.id}: {e}')
            return Response(
                {'error': f'Could not list files: {e}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        created_count = 0
        current_paths = {f['path'] for f in files}

        # Only consider active (non-deleted) datasets when checking for existing
        existing_paths = set(
            Dataset.objects.filter(
                backend=backend,
                deleted_at__isnull=True,
            ).values_list('path', flat=True)
        )

        for file_info in files:
            if file_info['path'] not in existing_paths:
                dataset = Dataset.objects.create(
                    backend=backend,
                    path=file_info['path'],
                    name=file_info['path'].split('/')[-1],
                    owner_id=request.user.sub,
                )
                PID.mint_internal(dataset)
                if backend.backend_type != BackendType.LOCAL:
                    extract_metadata.delay(str(dataset.id))
                created_count += 1

        # Remove datasets whose files no longer exist on the backend
        current_paths = {f['path'] for f in files}
        removed_count = 0
        for dataset in Dataset.objects.filter(backend=backend, deleted_at__isnull=True):
            if dataset.path not in current_paths:
                if dataset.pids.exists():
                    dataset.deleted_at = timezone.now()
                    dataset.save(update_fields=['deleted_at'])
                else:
                    dataset.delete()
                removed_count += 1

        return Response({
            'indexed': created_count,
            'removed': removed_count,
            'total': len(files),
            'message': f'Registered {created_count} new, removed {removed_count} deleted ({len(files)} files found)',
        })
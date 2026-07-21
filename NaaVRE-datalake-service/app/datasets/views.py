import logging

from django.utils import timezone
from rest_framework import viewsets, mixins, status
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from app.pids.models import PID
from app.storage_backends.models import BackendType
from .models import Dataset, DatasetStatus, DataLake, Subscription, DatasetAccess
from .tasks import extract_metadata
from .serializers import (
    DatasetSerializer,
    DatasetListSerializer,
    DatasetVersionSerializer,
    DataLakeSerializer,
    SubscriptionSerializer,
)

logger = logging.getLogger(__name__)


class DatasetViewSet(viewsets.ModelViewSet):
    """
    Core dataset CRUD.

    List uses the lightweight serializer (no metadata JSONB).
    Retrieve uses the full serializer (includes metadata and PIDs).

    Delete is a soft delete — sets deleted_at rather than removing the row.
    The PID continues to resolve and returns a tombstone response.
    Hard delete is only allowed before any PID has been assigned.
    """

    def get_queryset(self):
        qs = Dataset.objects.filter(
            owner_id=self.request.user.sub,
            deleted_at__isnull=True,
        ).select_related('backend').prefetch_related('pids')

        # Optional filters from query params
        backend_id = self.request.query_params.get('backend')
        fmt        = self.request.query_params.get('format')
        st         = self.request.query_params.get('status')
        search     = self.request.query_params.get('search')

        if backend_id:
            qs = qs.filter(backend_id=backend_id)
        if fmt:
            qs = qs.filter(format=fmt)
        if st:
            qs = qs.filter(status=st)
        if search:
            qs = qs.filter(name__icontains=search)

        return qs

    def get_serializer_class(self):
        if self.action == 'list':
            return DatasetListSerializer
        return DatasetSerializer

    def perform_create(self, serializer):
        dataset = serializer.save(owner_id=self.request.user.sub)
        # Mint internal PID immediately on registration
        PID.mint_internal(dataset)
        # Kick off background metadata extraction — except for local backends.
        # Celery runs inside the Docker container and cannot see the researcher's
        # host filesystem. Local file metadata is extracted client-side by the
        # JupyterLab extension instead (see AddStorageWizard / service.ts).
        if dataset.backend.backend_type != BackendType.LOCAL:
            extract_metadata.delay(str(dataset.id))

    def perform_update(self, serializer):
        """
        Recompute the FAIR score synchronously on every PATCH.

        This ensures the score stays current when the researcher edits
        description, licence, tags or any other metadata field — without
        waiting for a Celery task. For local backend datasets the Celery
        extraction task fails (Django can't read local files), so this is
        the only path that keeps the FAIR score up to date.
        """
        from .fair import compute_fair_score
        instance = serializer.save()
        instance.fair_score = compute_fair_score(instance)
        instance.save(update_fields=['fair_score'])


    @action(detail=True, methods=['get'], url_path='access')
    def access(self, request, pk=None):
        """
        GET /api/v1/datasets/{id}/access/

        Returns the fsspec URL and storage options needed to open this
        dataset from a notebook cell. Credentials are resolved server-side
        via get_credentials() — the client receives actual values, never
        raw credential references or env var names.

        Used by the vrefs Python client:
            import vrefs
            ds = vrefs.get("dl:{id}")
        """
        from app.storage_backends.adapters import get_access_info
        dataset = self.get_object()
        try:
            info = get_access_info(dataset.backend, dataset.path)
        except NotImplementedError as e:
            return Response({'error': str(e)}, status=400)
        except Exception as e:
            logger.error(f'get_access_info failed for {dataset.id}: {e}')
            return Response(
                {'error': f'Could not resolve access info: {e}'},
                status=500
            )

        # Log the access event (best-effort — never blocks the response)
        try:
            if dataset.owner_id != request.user.sub:
                DatasetAccess.objects.create(
                    dataset=dataset,
                    accessor_id=request.user.sub,
                    access_type=DatasetAccess.AccessType.OPEN,
                )
        except Exception:
            pass

        return Response(info)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.pids.exists():
            # Soft delete — PID must remain resolvable (FAIR principle F1)
            instance.deleted_at = timezone.now()
            instance.save(update_fields=['deleted_at'])
        else:
            # No PID assigned yet — safe to hard delete
            instance.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['get'], url_path='versions')
    def versions(self, request, pk=None):
        """GET /api/v1/datasets/{id}/versions/"""
        dataset = self.get_object()
        versions = dataset.versions.all()
        serializer = DatasetVersionSerializer(versions, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get', 'post'], url_path='access-grants')
    def access_grants(self, request, pk=None):
        """
        GET  /api/v1/datasets/{id}/access-grants/ — list grants
        POST /api/v1/datasets/{id}/access-grants/ — create a grant
        Only the dataset owner can manage grants.
        """
        dataset = self.get_object()

        if request.method == 'GET':
            grants = dataset.access_grants.all()
            return Response(AccessGrantSerializer(grants, many=True).data)

        serializer = AccessGrantSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(
            dataset=dataset,
            granted_by=request.user.sub,
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class DataLakeView(APIView):
    """
    GET  /api/v1/lake/ — get or create the researcher's data lake
    PATCH /api/v1/lake/ — update lake (toggle published, set title/description)

    One data lake per researcher. Created automatically on first access.
    """

    def get(self, request):
        lake, _ = DataLake.objects.get_or_create(owner_id=request.user.sub)
        return Response(DataLakeSerializer(lake).data)

    def patch(self, request):
        lake, _ = DataLake.objects.get_or_create(owner_id=request.user.sub)
        serializer = DataLakeSerializer(lake, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


class PublicLakeView(APIView):
    """
    GET /api/v1/lakes/{owner_id}/
    Public endpoint — no authentication required.
    Returns the published lake and its public/restricted datasets.
    """
    permission_classes = [AllowAny]

    def get(self, request, owner_id):
        try:
            lake = DataLake.objects.get(owner_id=owner_id, published=True)
        except DataLake.DoesNotExist:
            return Response(
                {'error': 'Lake not found or not published'},
                status=status.HTTP_404_NOT_FOUND,
            )

        datasets = Dataset.objects.filter(
            owner_id=owner_id,
            status__in=[DatasetStatus.PUBLIC, DatasetStatus.RESTRICTED],
            deleted_at__isnull=True,
        ).prefetch_related('pids')

        return Response({
            'lake': DataLakeSerializer(lake).data,
            'datasets': DatasetListSerializer(datasets, many=True).data,
        })


class DiscoverView(APIView):
    """
    GET /api/v1/discover/

    Returns all published lakes with their public datasets.
    No authentication required — this is a public discovery endpoint.
    """
    permission_classes = [AllowAny]

    def get(self, request):
        lakes = DataLake.objects.filter(published=True)
        result = []
        for lake in lakes:
            datasets = Dataset.objects.filter(
                owner_id=lake.owner_id,
                status=DatasetStatus.PUBLIC,
                deleted_at__isnull=True,
            ).prefetch_related('pids')
            result.append({
                'lake': DataLakeSerializer(lake).data,
                'datasets': DatasetListSerializer(datasets, many=True).data,
            })
        return Response(result)


class SubscriptionViewSet(viewsets.ModelViewSet):
    """
    GET    /api/v1/subscriptions/       — list my subscriptions
    POST   /api/v1/subscriptions/       — subscribe { source_owner_id }
    DELETE /api/v1/subscriptions/{id}/  — unsubscribe
    """
    http_method_names = ['get', 'post', 'delete', 'head', 'options']

    def get_queryset(self):
        return Subscription.objects.filter(subscriber_id=self.request.user.sub)

    def get_serializer_class(self):
        return SubscriptionSerializer

    def create(self, request, *args, **kwargs):
        source_owner_id = request.data.get('source_owner_id', '')
        subscription, created = Subscription.objects.get_or_create(
            subscriber_id=request.user.sub,
            source_owner_id=source_owner_id,
        )
        serializer = self.get_serializer(subscription)
        return Response(serializer.data, status=201 if created else 200)


class SubscribedDatasetsView(APIView):
    """
    GET /api/v1/subscribed-datasets/

    Returns all public datasets from lakes the researcher subscribes to.
    Same format as the main dataset list so the frontend can reuse DatasetRow.
    Each dataset includes a 'source_owner_id' field identifying whose lake
    it comes from.
    """

    def get(self, request):
        subscriptions = Subscription.objects.filter(subscriber_id=request.user.sub)
        source_owner_ids = subscriptions.values_list('source_owner_id', flat=True)

        datasets = Dataset.objects.filter(
            owner_id__in=source_owner_ids,
            status=DatasetStatus.PUBLIC,
            deleted_at__isnull=True,
        ).prefetch_related('pids').select_related('backend')

        return Response(DatasetListSerializer(datasets, many=True).data)


class DatasetImportView(APIView):
    """
    POST /api/v1/datasets/{id}/import/

    Import a public dataset from another researcher's lake into your own.
    Creates a new Dataset record under your owner_id pointing to the same
    file on the same backend. No data is copied — this is a lightweight
    reference copy with full provenance tracking.

    The imported dataset gets its own PID and can be independently
    edited, published, or deleted without affecting the original.
    """

    def post(self, request, pk):
        from app.pids.models import PID

        try:
            source = Dataset.objects.get(pk=pk, status=DatasetStatus.PUBLIC, deleted_at__isnull=True)
        except Dataset.DoesNotExist:
            return Response({'error': 'Dataset not found or not public'}, status=404)

        if source.owner_id == request.user.sub:
            return Response({'error': 'Cannot import your own dataset'}, status=400)

        # Prevent importing the same source dataset twice
        already = Dataset.objects.filter(
            owner_id=request.user.sub,
            deleted_at__isnull=True,
        ).extra(where=["source_dataset_ids @> %s::jsonb"], params=[f'["{str(source.id)}"]'])
        if already.exists():
            return Response({'error': 'Already imported'}, status=400)

        # Create a copy under the importing researcher's ownership
        imported = Dataset.objects.create(
            owner_id=request.user.sub,
            backend=source.backend,
            path=source.path,
            name=source.name,
            format=source.format,
            size_bytes=source.size_bytes,
            checksum_sha256=source.checksum_sha256,
            licence=source.licence,
            metadata=source.metadata,
            fair_score=source.fair_score,
            status=DatasetStatus.PRIVATE,
            source_dataset_ids=[str(source.id)],
        )
        PID.mint_internal(imported)

        # Log the import event on the source dataset
        DatasetAccess.objects.create(
            dataset=source,
            accessor_id=request.user.sub,
            access_type=DatasetAccess.AccessType.IMPORT,
        )

        return Response(DatasetSerializer(imported).data, status=201)


class DatasetAccessLogView(APIView):
    """
    GET /api/v1/datasets/{id}/access-log/

    Returns the access log for a dataset. Owner only.
    Shows who opened or imported the dataset and when.
    """

    def get(self, request, pk):
        try:
            dataset = Dataset.objects.get(
                pk=pk,
                owner_id=request.user.sub,
                deleted_at__isnull=True,
            )
        except Dataset.DoesNotExist:
            return Response({'error': 'Dataset not found'}, status=404)

        log = dataset.access_log.all()[:100]
        return Response([{
            'accessor_id': e.accessor_id,
            'access_type': e.access_type,
            'accessed_at': e.accessed_at.isoformat(),
        } for e in log])
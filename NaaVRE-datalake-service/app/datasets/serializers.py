import json
from rest_framework import serializers
from .models import Dataset, DatasetVersion, DataLake, Subscription


class DatasetVersionSerializer(serializers.ModelSerializer):
    class Meta:
        model  = DatasetVersion
        fields = [
            'id', 'version_number', 'path',
            'checksum_sha256', 'size_bytes',
            'change_note', 'created_by', 'created_at',
        ]
        read_only_fields = ['id', 'created_at']


class DatasetSerializer(serializers.ModelSerializer):
    """
    Full dataset representation including PIDs and version count.

    bbox is returned as GeoJSON rather than a raw geometry object
    so the frontend can use it directly without any parsing.
    """
    pids        = serializers.SerializerMethodField()
    bbox_geojson = serializers.SerializerMethodField()
    version_count = serializers.SerializerMethodField()

    class Meta:
        model  = Dataset
        fields = [
            'id', 'backend', 'path', 'name', 'format',
            'size_bytes', 'checksum_sha256', 'licence', 'status',
            'metadata', 'fair_score',
            'bbox_geojson', 'crs',
            'source_workflow_id', 'source_dataset_ids',
            'virtual_lab', 'pids', 'version_count',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'fair_score', 'pids', 'version_count',
            'created_at', 'updated_at',
        ]

    def get_pids(self, obj):
        return list(
            obj.pids.values('pid_type', 'pid_value', 'resolver_url')
        )

    def get_bbox_geojson(self, obj):
        if obj.bbox:
            return json.loads(obj.bbox.geojson)
        return None

    def get_version_count(self, obj):
        return obj.versions.count()


class DatasetListSerializer(serializers.ModelSerializer):
    """
    Lightweight serializer for the dataset list view.
    Excludes the full metadata JSONB to keep list responses fast.
    """
    pids         = serializers.SerializerMethodField()
    bbox_geojson = serializers.SerializerMethodField()

    class Meta:
        model  = Dataset
        fields = [
            'id', 'name', 'format', 'size_bytes',
            'licence', 'status', 'fair_score',
            'bbox_geojson', 'pids',
            'created_at', 'updated_at',
        ]

    def get_pids(self, obj):
        return list(obj.pids.values('pid_type', 'pid_value'))

    def get_bbox_geojson(self, obj):
        if obj.bbox:
            return json.loads(obj.bbox.geojson)
        return None


class DataLakeSerializer(serializers.ModelSerializer):
    public_url = serializers.SerializerMethodField()

    class Meta:
        model  = DataLake
        fields = [
            'id', 'owner_id', 'published', 'title', 'description',
            'public_url', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'owner_id', 'public_url', 'created_at', 'updated_at']

    def get_public_url(self, obj):
        if obj.published:
            return f'/api/v1/lakes/{obj.owner_id}/'
        return None


class SubscriptionSerializer(serializers.ModelSerializer):
    class Meta:
        model  = Subscription
        fields = ['id', 'subscriber_id', 'source_owner_id', 'created_at']
        read_only_fields = ['id', 'subscriber_id', 'created_at']
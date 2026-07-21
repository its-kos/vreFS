from rest_framework import serializers
from .models import StorageBackend


class StorageBackendSerializer(serializers.ModelSerializer):
    """
    Credentials are write-only — accepted on create, never returned.
    This prevents credentials leaking through the API.
    """
    credentials = serializers.JSONField(write_only=True, required=False, default=dict)

    class Meta:
        model  = StorageBackend
        fields = [
            'id', 'name', 'backend_type', 'status',
            'endpoint_url', 'root_path', 'credentials',
            'virtual_lab', 'dataset_count', 'total_size_bytes',
            'last_synced_at', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'status', 'dataset_count', 'total_size_bytes',
            'last_synced_at', 'created_at', 'updated_at',
        ]
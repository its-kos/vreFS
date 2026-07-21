from rest_framework import serializers
from .models import StagedDataset


class StagedDatasetSerializer(serializers.ModelSerializer):
    staging_path = serializers.ReadOnlyField()

    class Meta:
        model  = StagedDataset
        fields = [
            'id', 'dataset', 'status',
            'staged_bucket', 'staged_key', 'staging_path',
            'expires_at', 'workflow_run_id',
            'dataset_version', 'error_message',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'status', 'staged_bucket', 'staged_key',
            'staging_path', 'expires_at', 'error_message',
            'created_at', 'updated_at',
        ]
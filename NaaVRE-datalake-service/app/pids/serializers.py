from rest_framework import serializers
from .models import PID


class PIDSerializer(serializers.ModelSerializer):
    class Meta:
        model  = PID
        fields = ['id', 'pid_type', 'pid_value', 'resolver_url', 'created_at']
        read_only_fields = ['id', 'created_at']
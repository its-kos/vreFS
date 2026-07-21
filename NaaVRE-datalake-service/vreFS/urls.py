from django.urls import path, include

urlpatterns = [
    path('api/v1/', include('app.datasets.urls')),
    path('api/v1/', include('app.storage_backends.urls')),
    path('api/v1/', include('app.pids.urls')),
    path('api/v1/', include('app.staging.urls')),
]
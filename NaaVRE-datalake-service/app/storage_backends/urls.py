from rest_framework.routers import DefaultRouter
from .views import StorageBackendViewSet

router = DefaultRouter()
router.register('storage-backends', StorageBackendViewSet, basename='storage-backend')
urlpatterns = router.urls
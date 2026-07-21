from rest_framework.routers import DefaultRouter
from .views import StagedDatasetViewSet

router = DefaultRouter()
router.register('staging', StagedDatasetViewSet, basename='staging')
urlpatterns = router.urls
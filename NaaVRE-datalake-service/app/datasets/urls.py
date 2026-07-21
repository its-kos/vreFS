from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import (
    DatasetViewSet, DataLakeView, PublicLakeView,
    DiscoverView, SubscriptionViewSet, SubscribedDatasetsView,
    DatasetImportView, DatasetAccessLogView,
)

router = DefaultRouter()
router.register('datasets', DatasetViewSet, basename='dataset')
router.register('subscriptions', SubscriptionViewSet, basename='subscription')

urlpatterns = router.urls + [
    path('lake/',                          DataLakeView.as_view(),          name='lake'),
    path('lakes/<str:owner_id>/',          PublicLakeView.as_view(),        name='public-lake'),
    path('discover/',                      DiscoverView.as_view(),          name='discover'),
    path('subscribed-datasets/',           SubscribedDatasetsView.as_view(), name='subscribed-datasets'),
    path('datasets/<uuid:pk>/import/',     DatasetImportView.as_view(),     name='dataset-import'),
    path('datasets/<uuid:pk>/access-log/', DatasetAccessLogView.as_view(),  name='dataset-access-log'),
]
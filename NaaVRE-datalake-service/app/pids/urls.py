from django.urls import path
from .views import PIDResolveView

urlpatterns = [
    path('pids/resolve/<str:pid>/', PIDResolveView.as_view(), name='pid-resolve'),
]
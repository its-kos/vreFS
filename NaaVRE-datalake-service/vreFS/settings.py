import environ
import os

env = environ.Env(
    DEBUG=(bool, False),
    DISABLE_AUTH=(bool, False),
    CORS_ALLOW_ALL_ORIGINS=(bool, True),
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SECRET_KEY = env('SECRET_KEY', default='dev-secret-key')
DEBUG = env('DEBUG')
ALLOWED_HOSTS = env.list('ALLOWED_HOSTS', default=['*'])

DISABLE_AUTH = env('DISABLE_AUTH')
FAKE_JWT_SECRET = env('FAKE_JWT_SECRET', default='fake-secret')

OIDC_JWKS_URI = env(
    'OIDC_JWKS_URI',
    default='https://naavre-dev.test/auth/realms/vre/protocol/openid-connect/certs'
)
OIDC_ISSUER = env(
    'OIDC_ISSUER',
    default='https://naavre-dev.test/auth/realms/vre'
)

INSTALLED_APPS = [
    'django.contrib.contenttypes',
    'django.contrib.auth',
    'django.contrib.gis',
    'rest_framework',
    'corsheaders',
    'app.datasets',
    'app.storage_backends',
    'app.pids',
    'app.staging',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'vreFS.urls'

DATABASES = {
    'default': {
        'ENGINE': 'django.contrib.gis.db.backends.postgis',
        'NAME': env('DB_NAME', default='vrefs'),
        'USER': env('DB_USER', default='vrefs'),
        'PASSWORD': env('DB_PASSWORD', default='vrefs'),
        'HOST': env('DB_HOST', default='localhost'),
        'PORT': env('DB_PORT', default='5432'),
    }
}

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'app.utils.auth.KeycloakAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer',
    ],
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 50,
}

CORS_ALLOW_ALL_ORIGINS = env('CORS_ALLOW_ALL_ORIGINS')
CORS_ALLOWED_ORIGINS = env.list('CORS_ALLOWED_ORIGINS', default=[])

S3_STAGING_ENDPOINT      = env('S3_STAGING_ENDPOINT',      default='http://localhost:9000')
S3_STAGING_BUCKET        = env('S3_STAGING_BUCKET',        default='vrefs-staging')
S3_STAGING_TTL_DAYS      = env.int('S3_STAGING_TTL_DAYS',  default=60)
S3_STAGING_ACCESS_KEY    = env('S3_STAGING_ACCESS_KEY',    default='minioadmin')
S3_STAGING_SECRET_KEY    = env('S3_STAGING_SECRET_KEY',    default='minioadmin')
# Files larger than this will not be staged automatically (1 GB default)
S3_STAGING_MAX_SIZE_BYTES = env.int('S3_STAGING_MAX_SIZE_BYTES', default=1073741824)

CELERY_BROKER_URL = env('CELERY_BROKER_URL', default='redis://localhost:6379/0')
CELERY_RESULT_BACKEND = env('CELERY_RESULT_BACKEND', default='redis://localhost:6379/0')

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = False
USE_TZ = True
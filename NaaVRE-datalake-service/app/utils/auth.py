import logging
from functools import lru_cache

import jwt
from django.conf import settings
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

logger = logging.getLogger(__name__)


class VreFSUser:
    def __init__(self, sub, username, email='', groups=None):
        self.sub = sub
        self.username = username
        self.email = email
        self.groups = groups or []
        self.is_authenticated = True
        self.is_anonymous = False

    def __str__(self):
        return self.username

    def has_s3_bucket_access(self, bucket_name):
        return f's3-{bucket_name}-users' in self.groups


@lru_cache(maxsize=1)
def _jwks_client():
    return jwt.PyJWKClient(settings.OIDC_JWKS_URI)


def _decode_keycloak(token):
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=['RS256'],
            options={'verify_aud': False},
        )
    except jwt.ExpiredSignatureError:
        raise AuthenticationFailed('Token expired')
    except jwt.InvalidTokenError as e:
        raise AuthenticationFailed(f'Invalid token: {e}')


def _decode_fake(token):
    try:
        return jwt.decode(token, settings.FAKE_JWT_SECRET, algorithms=['HS256'])
    except jwt.InvalidTokenError as e:
        raise AuthenticationFailed(f'Invalid token: {e}')


class KeycloakAuthentication(BaseAuthentication):

    def authenticate(self, request):
        header = request.META.get('HTTP_AUTHORIZATION', '')
        if not header.startswith('Bearer '):
            return None
        token = header.split(' ', 1)[1]
        payload = _decode_fake(token) if settings.DISABLE_AUTH else _decode_keycloak(token)
        return (VreFSUser(
            sub=payload.get('sub', ''),
            username=payload.get('preferred_username', ''),
            email=payload.get('email', ''),
            groups=payload.get('groups', []),
        ), token)

    def authenticate_header(self, request):
        return 'Bearer'
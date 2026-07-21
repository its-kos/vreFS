"""
local_communicator_stub

LOCAL DEV ONLY. Stand-in for NaaVRE-communicator-jupyterlab.

Registers a Tornado handler at /naavre-communicator/external-service on
the same Jupyter server as the frontend — identical path to production.
The frontend calls it with a relative URL so there is no cross-origin
request and no CORS at all, exactly as in a real NaaVRE deployment.

The only difference from production: this stub injects a fake JWT
(the backend has DISABLE_AUTH=true). The real communicator injects the
researcher's live Keycloak token instead.

To uninstall: pip uninstall local-communicator-stub
Nothing in vreFS references this package by name.
"""


def _jupyter_server_extension_points():
    return [{"module": "local_communicator_stub"}]


def load_jupyter_server_extension(server_app):
    from .handlers import setup_handlers
    setup_handlers(server_app.web_app)
    server_app.log.info(
        "local-communicator-stub: registered at "
        "/naavre-communicator/external-service"
    )
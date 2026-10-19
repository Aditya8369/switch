"""`GET /gateway/discovery`: where this server can be reached.

A Switch deployment usually has two public origins: the dashboard, whose web
files a separate container serves, and the agent bridge, which agents and
controllers connect to. Both forward `/gateway/*` to switch-core, so this one
path answers on whichever address a person has. Switch Console calls it to turn
one typed address into both, instead of asking for two.

It is served without a session, alongside `/auth/config`, and shares that
surface's rules: frozen, outside the versioned `gateway-api` contract, and
limited to what it must say. See `DiscoveryResponse`.
"""

from __future__ import annotations

from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends

from switch_core.config import SwitchConfig
from switch_core.gateway.dependencies import get_config
from switch_core.gateway.schemas import DiscoveryResponse

router = APIRouter()

_DEFAULT_PORTS = {"http": 80, "https": 443}


def public_origin(value: str | None) -> str | None:
    """`value` reduced to scheme, host and any non-default port, or `None`.

    Configuration is the only source, and an operator may have written a
    trailing slash, a path, or the scheme's own port; a client compares
    origins, so it is handed the bare one. A value with no scheme or host is
    not an origin a client could connect to, and is reported as unset rather
    than passed on.
    """
    if value is None or not value.strip():
        return None
    parts = urlsplit(value.strip())
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parts.hostname:
        return None
    host = parts.hostname.lower()
    if ":" in host:  # an IPv6 literal keeps its brackets
        host = f"[{host}]"
    port = parts.port
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


@router.get("/discovery")
async def discovery(
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> DiscoveryResponse:
    """The server's public dashboard and agent-bridge origins, or null.

    Unauthenticated, and binding no tenant, on purpose: a client reads this
    before it has signed in, and possibly before it knows which of the
    server's addresses it has. Both values are deployment-wide configuration;
    nothing about any workspace, user or session is read or returned.
    """
    return DiscoveryResponse(
        gateway_url=public_origin(config.frontend_base_url),
        api_url=public_origin(config.gateway_public_url),
    )

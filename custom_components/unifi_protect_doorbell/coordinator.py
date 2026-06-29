"""DataUpdateCoordinator for the UniFi Protect Doorbell integration."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import AddonApiClient, CannotConnect
from .const import DOMAIN, UPDATE_INTERVAL

_LOGGER = logging.getLogger(__name__)


class DoorbellCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls /api/status, /api/settings and /api/chime-settings every 30 s.

    /api/status is mandatory; the other two are best-effort — if they fail
    (e.g. camera not yet loaded), the coordinator still succeeds and the
    affected entities become unavailable individually.
    """

    def __init__(self, hass: HomeAssistant, client: AddonApiClient) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.client = client

    async def _async_update_data(self) -> dict[str, Any]:
        # /api/status is required — failure here marks all entities unavailable.
        try:
            status = await self.client.get_status()
        except CannotConnect as err:
            raise UpdateFailed(f"Add-on not reachable: {err}") from err

        # /api/settings and /api/chime-settings are optional.
        results = await asyncio.gather(
            self.client.get_settings(),
            self.client.get_chime_settings(),
            return_exceptions=True,
        )
        settings: dict[str, Any] = {}
        chimes: dict[str, Any] = {}

        if isinstance(results[0], dict):
            s = results[0]
            # The endpoint returns {"error": "..."} with HTTP 503 when camera
            # details are not yet loaded. Treat that as empty settings.
            if "error" not in s:
                settings = s
        elif isinstance(results[0], Exception):
            _LOGGER.debug("Could not fetch /api/settings: %s", results[0])

        if isinstance(results[1], dict):
            chimes = results[1]
        elif isinstance(results[1], Exception):
            _LOGGER.debug("Could not fetch /api/chime-settings: %s", results[1])

        return {"status": status, "settings": settings, "chimes": chimes}

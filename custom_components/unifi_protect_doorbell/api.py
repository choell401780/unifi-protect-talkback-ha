"""HTTP client for the UniFi Protect Doorbell add-on API."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class CannotConnect(Exception):
    """Raised when the add-on API is unreachable or returns an error."""


class AddonApiClient:
    """Thin async client for the add-on REST API."""

    def __init__(
        self,
        addon_url: str,
        session: aiohttp.ClientSession,
        verify_ssl: bool = False,
    ) -> None:
        self._base = addon_url.rstrip("/")
        self._session = session
        # aiohttp ssl=False → skip cert verification; ssl=None → system default
        self._ssl: bool | None = None if verify_ssl else False

    # ── Private helpers ───────────────────────────────────────────────────────

    async def _get(self, path: str) -> dict[str, Any]:
        try:
            async with self._session.get(
                f"{self._base}{path}",
                ssl=self._ssl,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                resp.raise_for_status()
                return await resp.json()  # type: ignore[return-value]
        except aiohttp.ClientError as err:
            raise CannotConnect(str(err)) from err
        except asyncio.TimeoutError as err:
            raise CannotConnect("Timeout connecting to add-on") from err

    async def _post(self, path: str, data: dict[str, Any]) -> dict[str, Any]:
        try:
            async with self._session.post(
                f"{self._base}{path}",
                json=data,
                ssl=self._ssl,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                resp.raise_for_status()
                return await resp.json()  # type: ignore[return-value]
        except aiohttp.ClientError as err:
            raise CannotConnect(str(err)) from err
        except asyncio.TimeoutError as err:
            raise CannotConnect("Timeout connecting to add-on") from err

    # ── Read endpoints ────────────────────────────────────────────────────────

    async def get_status(self) -> dict[str, Any]:
        """Return NVR status, camera info, and stream health."""
        return await self._get("/api/status")

    async def get_settings(self) -> dict[str, Any]:
        """Return speaker/mic volumes, LCD message, and feature flags."""
        return await self._get("/api/settings")

    async def get_chime_settings(self) -> dict[str, Any]:
        """Return ringtone list, chime config, and doorbell ring settings."""
        return await self._get("/api/chime-settings")

    async def get_version(self) -> dict[str, Any]:
        """Return add-on version info (requires /api/version endpoint)."""
        return await self._get("/api/version")

    # ── Write endpoints ───────────────────────────────────────────────────────

    async def update_settings(self, data: dict[str, Any]) -> dict[str, Any]:
        """Patch camera settings (speaker volume, mic volume)."""
        return await self._post("/api/settings", data)

    async def set_display_message(
        self, message: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Set or clear the LCD display message."""
        return await self._post("/api/display-message", {"message": message})

    async def update_chime_settings(self, data: dict[str, Any]) -> dict[str, Any]:
        """Update chime / doorbell ring settings."""
        return await self._post("/api/chime-settings", data)

    async def restart_stream(self) -> dict[str, Any]:
        """Restart the HLS/ffmpeg pipeline."""
        return await self._post("/api/stream/restart", {})

    # ── Convenience ──────────────────────────────────────────────────────────

    @property
    def hls_url(self) -> str:
        """Full URL to the HLS m3u8 playlist served by the add-on."""
        return f"{self._base}/hls/stream.m3u8"

    @property
    def base_url(self) -> str:
        return self._base

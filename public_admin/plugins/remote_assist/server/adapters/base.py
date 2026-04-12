from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional

from ..types import AssistSession


class BaseAssistAdapter(ABC):
    @property
    @abstractmethod
    def site_type(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def matches_proxy_path(self, path: str) -> bool:
        raise NotImplementedError

    @abstractmethod
    def build_bridge_script(
        self,
        session: AssistSession,
        ws_endpoint: str,
        role: str,
        readonly: bool,
        extra: Optional[dict[str, Any]] = None,
    ) -> str:
        raise NotImplementedError

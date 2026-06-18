from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass(frozen=True)
class IpLocationPoint:
    label: str = ""
    country: str = ""
    region: str = ""
    city: str = ""
    latitude: float | None = None
    longitude: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class IpIntelligenceRecord:
    ip: str = ""
    country_code: str = ""
    country: str = ""
    subdivision: str = ""
    city: str = ""
    latitude: float | None = None
    longitude: float | None = None
    time_zone: str = ""
    is_eu: bool = False
    is_anycast: bool = False
    is_satellite: bool = False
    asn: str = ""
    organization: str = ""
    carrier: str = ""
    vpn: bool = False
    proxy: bool = False
    tor: bool = False
    hosting: bool = False
    source: str = ""
    cached_at: float = 0.0
    expires_at: float = 0.0
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

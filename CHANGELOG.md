# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project loosely follows [Semantic Versioning](https://semver.org/).
Version numbers match the script's internal version string (`Wersja / Version` in `src/control.js`).

> Dates below are approximate — adjust them to your actual commit/tag dates.

## [5.1.0] - 2026-07-07

Hardening release for deployments on unstable Wi-Fi.

### Added
- `safeParse()` helper — wraps every `JSON.parse` call and returns `null` instead of throwing on empty, partial or malformed HTTP responses.
- `EM_MISS_LIMIT` config option — tolerates transient Pro 3EM read misses (default `2`) before the heaters fail-safe to OFF, to avoid nuisance switching on brief network drops.

### Changed
- Sensor and meter reads no longer crash the script when a device is momentarily unreachable; a bad read is treated as "no data" and the last good value is held.

### Fixed
- Script could stop with an uncaught exception when a remote device returned an empty or truncated body during a Wi-Fi drop (the most likely cause of the reported "script sometimes stops").

### Notes
- The WebSocket `1003` / `1006` error some users saw in the app is the live-log console stream dropping (cosmetic) — the control logic keeps running. The real stop was the unguarded parse, addressed here.
- Recommended alongside this release: put the Pro devices (Pro 3EM + 3× Pro 3, which have RJ45) on wired Ethernet to take them off Wi-Fi, and enable **Run on startup** on the script.

## [5.0.0] - 2026-07-02

Initial public release.

### Added
- **PV-surplus heater control** — incremental 2 kW staging driven by grid export measured natively by a Shelly Pro 3EM; the system never imports from the grid.
- **Differential circulation pump** — buffer vs coldest DHW cylinder, 10/6 °C hysteresis, with an anti-scald DHW limit.
- **Safety layers** — buffer over-temperature cutoff, per-stage heater watchdog (auto-off), measurement fail-safe, and a DS18B20 `85 °C` error filter with last-good hold.
- **Flexible sensor map** — a single `SENSORS` block declares each sensor's `local` flag and component `id`; 4 sensors split 2+2 across two 1PM Gen4 + Add-on.
- **id-based sensor addressing** — for newer firmware that no longer exposes the 1-Wire address.
- **Bilingual documentation (PL/EN)** — deployment guide, DS18B20 wiring diagram, and a one-page overview.

[5.1.0]: https://github.com/pietia28/shelly-pv-heat/releases/tag/v5.1.0
[5.0.0]: https://github.com/pietia28/shelly-pv-heat/releases/tag/v5.0.0

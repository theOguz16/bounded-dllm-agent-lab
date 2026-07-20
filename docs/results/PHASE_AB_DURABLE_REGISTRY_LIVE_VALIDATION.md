# Phase AB — Durable Consumption Registry Live Validation

## Status

**PASS**

- Date: `2026-07-20`
- Environment: RunPod
- Validated source commit: `420a3ac`
- Command: `node scripts/live-durable-consumption-registry-suite.cjs`

## Result

```json
{
  "stable": true,
  "raceDecisions": [
    "durable_consumption_reserved",
    "durable_consumption_already_reserved"
  ],
  "finalDecision": "durable_consumption_failed_requires_review",
  "replayDecision": "durable_consumption_failed_requires_review",
  "tamperDecision": "durable_consumption_reservation_invalid",
  "checks": {
    "initialAvailable": true,
    "exactlyOneWinner": true,
    "persistedReserved": true,
    "failedClosed": true,
    "persistedAfterReopen": true,
    "replayRejected": true,
    "tamperRejected": true,
    "repositoryClean": true,
    "realApplyExecuted": false,
    "rollbackExecuted": false
  }
}
```

Final marker:

```text
LIVE_DURABLE_CONSUMPTION_REGISTRY_PASSED
```

## Kanıtlanan davranışlar

- İki process arasından yalnızca biri reservation kazandı.
- Reservation restart sonrasında diskten okunabildi.
- Failed-finalized handoff replay girişimi reddedildi.
- Değiştirilmiş handoff fail-closed reddedildi.
- Gerçek repository apply veya rollback yapılmadı.
- Repository temiz kaldı.

## Claim boundary

Bu doğrulama, aynı persistent SQLite dosyasını kullanan processler arasındaki durability ve single-consumption davranışını kanıtlar.

Multi-host distributed coordination veya authenticated digital signature davranışını kanıtlamaz.


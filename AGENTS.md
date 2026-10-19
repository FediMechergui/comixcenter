# Android validation

The user wants app changes validated on this machine's Android emulator, with screenshots and latency measurements.

- Start an emulator or reuse a booted one before a validation pass. Do not boot duplicate instances of the same AVD.
- Build and install the candidate APK before testing its Android behavior.
- `python scripts/android-smoke.py --label <build>` starts the test AVD if needed, captures main screens and measures route readiness and gateway requests.
- `python scripts/android-download-smoke.py --label downloads-<build>` follows the main smoke test and checks generated direct downloads, progress across navigation, cancellation, retry, oversized/failed responses, credential redirects and process recovery.
- `python scripts/android-reading-smoke.py --label reading-<build>` checks source resume, generated comic import, offline images and the backup/restore UI. It creates test records on the emulator. Use `--skip-source` when validating an unchanged source browser separately.
- `python scripts/android-lifecycle-smoke.py --label lifecycle-<build>` follows the reading smoke test and checks background, rotation, process restart and a throttled gateway request.
- Keep screenshots and raw reports in ignored `scratch/android-validation/`; summarize reviewed evidence in `docs/validation/`. Never include provider keys or account fields in reports.
- Distinguish emulator/ADB startup, API response time and comic-image readiness. Record failed or variable runs; do not describe a single fast run as a guaranteed improvement.
- Follow `docs/road-to-1.0.md`; a preview is not a completed 1.0 launch while release gates remain open.

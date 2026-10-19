# Road to 1.0

The release promise: find a starting point, read inside the app, and always know where to continue.

## 0.3 reading reliability and recovery
- One native Read flow without a second reader-opening step.
- Persistent source URL, page selection and scroll position; continue shelf integration.
- Safe, reviewable personal backup and restore, excluding credentials and comic bytes.
- Clear offline-library storage information and bounded imports.
- Next unread guide stop and simpler daily navigation.
- Repeatable emulator screenshots and latency reports, plus offline and lifecycle checks.

## 0.4 direct downloads and import recovery
- Native streaming to private temporary storage with progress, cancellation and explicit retry.
- Downloads remain visible across app navigation; earlier history is expandable.
- Process interruption becomes a restartable job; abandoned temporary files and incomplete imports are recovered.
- Emulator checks cover oversized responses, broken/stalled connections, verification pages and credential stripping on redirects.
- Import cancellation rolls back extracted pages and library records; imports and backup restore cannot overlap.

## Remaining 1.0 gates
- Physical phone acceptance, including current Android System WebView.
- Larger/solid archives, memory pressure and broader rotation, background and upgrade regression checks. Direct downloads currently stop at 64 MB; retry starts over and requires the app process to stay alive. OS background downloading and byte-range resume are not implemented.
- Review provider permissions, attribution and gateway quotas before wider distribution.
- Verify source-specific behavior; protected sources are not guaranteed and never block the offline library.

Do not label a preview 1.0 while these gates remain open. Measurements distinguish app readiness, network responses and actual image loads.

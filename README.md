# OnePrep Video Publisher — Phase 1

A mobile-first vertical-video workflow. This repository contains the testable domain core and a deliberately narrow HTTP seam; provider adapters are credential-gated and must be added before production deployment.

## Architecture decision record
- **Web/API:** Node 20 HTTP service (replaceable adapter boundary), semantic static UI; single-user authorization via server-side `ALLOWED_EMAIL`.
- **Persistence/storage:** production target Postgres plus private S3-compatible object storage, signed URLs, multipart/resumable uploads. Never proxy video through the browser server.
- **Media:** FFmpeg worker (1080x1920 H.264/AAC, captions only); transcription adapter should support Deepgram or AssemblyAI after DPA/pricing review. Email adapter: Postmark/Resend. Slack adapter: bot token with `chat:write` to one invited channel.
- Queue/workers should be independently retryable and retain source + latest output only. OAuth Google secrets remain server-side.

## Local
`ALLOWED_EMAIL=you@example.com npm start`; the sample UI requires setting `localStorage.email` to that value. `npm test` runs core transition, validation, copy, retry and ceiling tests. The local server intentionally does not claim resumable uploads or provider integration.

## Setup/deployment
Create Google OAuth web credentials (redirect URI from deployment), Slack app/bot and invite it to the fixed channel; provision private object storage, Postgres, FFmpeg worker, transcription, email, and deployment secrets: `ALLOWED_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `STORAGE_*`, `TRANSCRIPTION_*`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `EMAIL_API_KEY`, `NOTIFICATION_EMAIL`. Configure HTTPS, secure HttpOnly cookies, CSRF, signed upload/download URLs, antivirus/media probing, and deletion jobs. Confirm provider retention/training/DPA terms; minimize retention and do not send secrets client-side.

## Cost and safety
Budget assumptions (verify current vendor pricing): storage/egress, transcription minutes, FFmpeg compute, email and Slack are usage-priced; target is ~$5/month for 10+ weekly videos, with warnings at $4/$8 and a hard $10 processing ceiling. Block new paid jobs at the ceiling while retaining downloads/review. Never expose private URLs, and audit auth, deletion, render/send version, retries and approvals.

## Scope / Phase 2
Phase 1 has no social publishing. Add independent Instagram and TikTok adapters with official OAuth, idempotency keys, per-platform retries and success records. Instagram Creator later requires connection to a controlled Facebook Page; TikTok eligibility and scopes must be verified through official OAuth/API approval. Later defaults (public visibility, TikTok comments on/Duet/Stitch off, Instagram share-to-feed on) are documented product defaults, not fake Phase 1 controls.

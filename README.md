# Itachi OTP Forwarder

This Node.js service provides an Itachi Uchiha-themed dashboard for multiple accounts. Each account has an isolated background worker that polls the CR API and forwards only newly discovered numeric OTP values to that account’s Telegram chats. Empty API responses, responses without an OTP, and previously forwarded OTP values are suppressed.

## Configuration

Create a local `.env` file from `.env.example`, or configure these variables directly in the deployment platform. The dashboard requires `ADMIN_USERNAME` and `ADMIN_PASSWORD` for the initial administrator account. Set a stable, high-entropy `SETTINGS_ENCRYPTION_KEY`; it is used to encrypt every user’s Telegram bot token and chat IDs at rest. Set the global `CRAPI_TOKEN` deployment secret for the polling service. `CRAPI_URL` defaults to `http://147.135.212.197/crapi/had/viewstats`, and `POLL_INTERVAL_MS` defaults to `30000` milliseconds. Optional CR API filters are `CRAPI_DT1`, `CRAPI_DT2`, `CRAPI_RECORDS`, `CRAPI_FILTERNUM`, and `CRAPI_FILTERCLI`.

The CR API token is a single server-level deployment secret and is no longer shown to new users. After signing in, each account saves only its own Telegram bot token and comma-separated Telegram chat IDs in the **Secure settings** panel. The server never returns token contents to the browser; it returns only masked values and readiness flags.

## Run

```bash
npm install
npm test
npm start
```

The service starts the HTTP dashboard and then discovers all accounts in `auth-users.json`. For every account with a complete credential set, it starts one worker, performs an immediate poll, and continues polling in the background. Saving an account’s settings safely stops and recreates only that account’s worker. Workers suppress concurrent overlapping polls, restart their polling interval after configuration changes, and persist hashed OTP fingerprints so a process restart does not resend previously forwarded codes.

## Railway deployment

Railway can deploy this repository with the included `railway.json`, which runs `npm start`, checks `/health`, and restarts the service after failure. Add the required variables from `.env.example` in the Railway service settings: `CRAPI_TOKEN`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SETTINGS_ENCRYPTION_KEY`. Add a Railway Volume and mount it at `/app/data`; the application automatically uses Railway’s `RAILWAY_VOLUME_MOUNT_PATH` value and persists accounts, encrypted Telegram settings, and worker state there. Railway documents that relative application data must be mounted under the application path, such as `/app/data`, for it to persist across deployments [1].

If the deployment log says `ADMIN_PASSWORD must contain at least 10 characters`, open Railway **Variables**, replace `ADMIN_PASSWORD` with a value of at least 10 characters, save the variables, and redeploy. Do not include quotation marks around the value, and do not use the placeholder from `.env.example`.

The login screen includes separate **Administrator login** and **New user login** modes. Applicants can request a username and receive a random one-time approval key that expires after 30 minutes. They send that key to the administrator through the built-in WhatsApp contact button for **923110470403**. The administrator enters the key in the **Approve registration request** panel; only then can the applicant create a password and complete registration. Administrators can also create team accounts directly from the User accounts panel. The browser dashboard is not required to remain open for forwarding to continue. Do not deploy multiple replicas of this service because each replica would run its own polling workers; use one service instance with one persistent volume.

## Persistence and deployment

The default Node process must be supervised by the deployment platform. The included restart policy handles process failures. Persist `auth-users.json`, `registration-requests.json`, `runtime-user-settings.json`, and `runtime-status.json` on durable storage; losing the encrypted settings file removes the saved account credentials, while losing the status file only resets operational history and duplicate fingerprints. Registration approval keys are stored only as SHA-256 hashes, not in plaintext.

## Security

The `.env` file and all runtime JSON stores are ignored by Git. Rotate any CR API or Telegram credentials that were ever committed in an earlier repository revision, and configure deployment secrets outside source control. Do not paste credentials into source files, commit messages, or public repositories. Use HTTPS in production so session cookies are marked `Secure`.

## Verification

The regression suite covers numeric OTP extraction, empty-message suppression, message formatting, two-user Telegram isolation, duplicate suppression, encrypted per-user settings, masked forwarding activity, and approved registration completion. Run it with `npm test` before deployment.

## References

[1]: https://docs.railway.com/volumes Railway, “Using Volumes.”

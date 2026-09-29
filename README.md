# VaultLock Pro

VaultLock is a private, editorial-style digital archive for personal documents. It uses Google OAuth, Supabase PostgreSQL and private Storage, plus a small Express API for authenticated uploads, temporary viewing links and profile operations.

## Architecture

- `frontend/` is plain HTML, CSS and JavaScript. Supabase JS restores the browser session and starts Google OAuth.
- `backend/` is an Express API. It verifies the Supabase access token and uses that same user token for every database and Storage request; it does not use a service role key.
- `supabase/schema.sql` creates the profile/document tables, triggers, indexes, RLS rules and VaultLock-owned Storage policies.
- Supabase Auth identifies users, PostgreSQL RLS enforces row ownership, and Storage RLS limits object paths to the authenticated user's UUID.
- Documents live in the private `vault_documents` bucket. The API creates 60-second signed URLs only after looking up the document through the authenticated user's RLS context.

## Features

Google-only login, persistent sessions, profile editing, document upload and deletion, metadata editing, seven folders, category/file-type filters, filename search, sorting, storage statistics and PDF/image viewing. DOCX opens through a short-lived link because the browser does not provide a faithful DOCX viewer by itself.

Accepted uploads are PDF, PNG, JPEG and DOCX, with a 25 MB limit. The API checks MIME type and basic file signatures (ZIP signature for DOCX); signature checks are useful validation but do not replace malware scanning.

## Supabase setup

1. Use the project URL `https://btnjovmlvibhmdvozysp.supabase.co`.
2. In Authentication → Providers, enable Google and configure the Google OAuth client and Supabase callback URL.
3. In Authentication → URL Configuration, allow the redirect `http://localhost:5500/frontend/index.html`.
4. Keep or create the private Storage bucket named `vault_documents`. Do not make it public. Set the 25 MB limit and allowed MIME types to PDF, PNG, JPEG and DOCX.
5. Run `supabase/schema.sql` in the SQL editor. It creates/updates VaultLock's schema and manages only policies named for VaultLock. It does not reset the project.
6. Check that no older permissive Storage or document policies grant wider access. PostgreSQL permissive policies combine with OR, so legacy project policies must be reviewed and retired by their owner if they weaken these restrictions.

The `handle_new_user()` trigger (`on_auth_user_created`) copies a Google user's name, email and avatar metadata to `profiles`. It swallows its own errors so a profile problem can never block Google sign-in; the frontend creates a missing profile as a fallback. The script also creates the `vault_documents` bucket if missing and forces it private with the 25 MB / MIME limits. Profile/document RLS policies limit users to their own rows. Storage policies inspect `split_part(name, '/', 1)`; they do not depend on a nonexistent `folder_name` field in `storage.objects`.

## Configuration

Copy `backend/.env.example` to `backend/.env` and set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CLIENT_URL` and `PORT`. `SUPABASE_SECRET_KEY` is optional and unused by this implementation; do not put it in the frontend or commit any `.env` file.

Set the same project URL and the **publishable key** (Supabase → Project Settings → API Keys, starts with `sb_publishable_`) in `frontend/config.js`. Both files ship with the placeholder `sb_publishable_YOUR_KEY`; until you replace it, the login page shows a configuration message and the backend logs a warning. This configuration file is browser-visible by design; only public publishable keys belong there. Never put a secret/service-role key into frontend files. When configuring another environment, replace the key in this file with that project's publishable key.

## Local development

In a terminal:

```powershell
cd backend
npm install
npm start
```

The API listens at `http://localhost:5000`. Start VS Code Live Server for `frontend/index.html` on port 5500. The OAuth redirect is explicitly `http://localhost:5500/frontend/index.html`; if Live Server chooses another port, change `REDIRECT_URL` in `frontend/config.js`, Supabase's allowlist, and `CLIENT_URL` together. Live Server opens `127.0.0.1` by default; the app automatically switches to `localhost`, because they are different browser origins, and a session saved on one is invisible to the other (this was why Google login appeared to succeed but stayed on the login screen).

The backend exposes `GET /api/health`, profile `GET/PATCH /api/profile`, document `GET/POST /api/documents`, metadata `PATCH /api/documents/:id`, temporary view `GET /api/documents/:id/download`, and `DELETE /api/documents/:id`. `/api/upload` is a compatible upload alias. CORS is limited to the configured client origin, Helmet sets security headers, JSON bodies are limited, and rate limiting is enabled.

## Checks and operation

`npm start` starts the backend and `GET http://localhost:5000/api/health` should return `{"status":"ok","service":"VaultLock API"}`. Browser-dependent checks require a configured Google provider and Supabase account; exercise sign-in, refresh, sign-out, profile edit, upload/view/delete, unsupported file types, over-limit files and cross-user access after configuring those external services. API data access remains RLS-protected even if the frontend is modified.

Deploy the static frontend over HTTPS, configure its API URL to the deployed backend, set the backend's exact `CLIENT_URL`, and add the production OAuth callback/redirect to Supabase and Google. Do not expose backend secrets. Keep Storage private and periodically review Supabase policies, OAuth redirect allowlists, audit needs and backup/retention settings.

## Viewing limitations

VaultLock does not claim to prevent screenshots. Short-lived signed URLs, authentication, in-app viewing, visible user/email/document watermarks, and disabling obvious context-menu/drag interactions are deterrents only. A browser cannot prevent screen capture, developer-tool inspection, or photographing the display.

# first-server

The Express + MongoDB/Mongoose backend for **CreativesSelect** — a social
platform for creatives (profiles, friends, groups, posts, AI-assisted
content) plus a personal Tasks tool, all behind one login.

The frontend lives in a sibling repo:
[CreativesSelect](https://github.com/OttoNyne/CreativesSelect). Full
architecture, data model, and API reference are documented there in
[`docs/ARCHITECTURE.md`](https://github.com/OttoNyne/CreativesSelect/blob/master/docs/ARCHITECTURE.md);
the security audit and penetration-testing writeup is in
[`docs/SECURITY_REVIEW.md`](https://github.com/OttoNyne/CreativesSelect/blob/master/docs/SECURITY_REVIEW.md).

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI and JWT_SECRET
npm start
```

The server listens on port 5000 (override with `PORT`) and logs
`Server running at http://localhost:5000` when ready.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB Atlas (or local) connection string |
| `JWT_SECRET` | yes | Signs/verifies the auth cookie |
| `PORT` | no (default 5000) | HTTP port |
| `CLIENT_URL` | no (default `http://localhost:3000`) | Allowed CORS origin — set this to your actual frontend origin (e.g. `http://localhost:5173` in dev) |
| `CLOUDINARY_CLOUD_NAME` | yes (for uploads) | Cloudinary account cloud name |
| `CLOUDINARY_API_KEY` | yes (for uploads) | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | yes (for uploads) | Cloudinary API secret |
| `CLOUDFLARE_ACCOUNT_ID` | no | With the token below, turns on real AI image generation (Cloudflare Workers AI). Without both, images fall back to the mock gradient provider |
| `CLOUDFLARE_API_TOKEN` | no | Cloudflare API token with Workers AI permission |
| `CLOUDFLARE_IMAGE_MODEL` | no (default `@cf/black-forest-labs/flux-1-schnell`) | Which Workers AI text-to-image model to use |

## Tests

```bash
npm test
```

Runs the Vitest + Supertest suite (auth flows + Tasks CRUD) against a
dedicated `creativeselect_test` database — never the dev database.

## API

Every route is mounted under `/api`. See
[`docs/ARCHITECTURE.md`](https://github.com/OttoNyne/CreativesSelect/blob/master/docs/ARCHITECTURE.md#4-api-reference)
in the frontend repo for the full endpoint reference (auth, profiles, posts,
comments, friends, groups, media, notifications, moderation, AI, tracks, and
tasks).

### Tasks — the full-CRUD resource

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/tasks` | required | List your own tasks — supports `?done=`, `?sort=`, `?page=`, `?limit=` |
| GET | `/api/tasks/:id` | required | Get one of your own tasks by id (`404` if it isn't yours) |
| POST | `/api/tasks` | required | Create a task: `{ title, done?, priority?, dueDate? }` |
| PUT | `/api/tasks/:id` | required | Update `title`/`done`/`priority`/`dueDate` — `owner` can't be reassigned |
| DELETE | `/api/tasks/:id` | required | Delete one of your own tasks |

## Uploads

Uploaded files (avatars, wallpapers, portfolio images, tracks) are streamed
directly to [Cloudinary](https://cloudinary.com) and stored by URL — nothing
is written to local disk, so files survive restarts and redeploys even on
Render's free tier (which has an ephemeral filesystem). Sign up for a free
Cloudinary account and set the three `CLOUDINARY_*` env vars above; without
them, `POST /api/media/upload` will fail.

## AI images and text

`POST /api/ai/image` generates a real image from the prompt using
[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
(FLUX.1 schnell) when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are
set, uploads it to Cloudinary, and returns the CDN URL. Each user is limited
to 10 images per hour, and prompts are truncated to 500 characters. If the
credentials aren't set, `MockAIProvider` is used instead: it turns the prompt
into a color-gradient SVG (a `data:` URI, nothing stored) and never looks at
what was asked for — fine for local development and tests, which need no keys.
`POST /api/ai/text` (bios, captions, blurbs) is likewise real when those credentials are set, using Llama 3.1 8B on Workers AI, capped at 30 per user per hour; without them it uses canned templates.

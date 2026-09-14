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

Uploaded files (avatars, wallpapers, portfolio images, tracks, AI-generated
images) are written to `uploads/` on local disk and served back via
`/uploads/...` — this directory is gitignored, not committed.

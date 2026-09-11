# first-server

A minimal Express server with a `tasks` REST resource backed by an in-memory array.

## Setup

```bash
npm install
npm start
```

The server listens on port 3000 and logs `Server running at http://localhost:3000` when ready.

## API

### Hello

| Method | Route | Description |
|---|---|---|
| GET | `/api/hello` | Returns `{ "message": "hello" }` |

### Tasks

Data store is an in-memory array, seeded with three example tasks on startup and reset whenever the server restarts. Each task has the shape:

```json
{ "id": 1, "title": "Buy groceries", "done": false }
```

| Method | Route | Description | Success | Errors |
|---|---|---|---|---|
| GET | `/tasks` | List all tasks | `200` + array | — |
| GET | `/tasks/:id` | Get one task by id | `200` + task | `404` if id not found |
| POST | `/tasks` | Create a task from `{ title, done? }`; `id` is generated via `Date.now()` | `201` + created task | `400` if `title` is missing |
| PUT | `/tasks/:id` | Update a task by id, merging the request body into it | `200` + updated task | `404` if id not found |
| DELETE | `/tasks/:id` | Remove a task by id | `204` (no body) | `404` if id not found |

#### Examples

```bash
curl http://localhost:3000/tasks

curl http://localhost:3000/tasks/1

curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Read a book"}'

curl -X PUT http://localhost:3000/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"done":true}'

curl -X DELETE http://localhost:3000/tasks/1
```

## Notes

- Data is not persisted — restarting the server resets `tasks` to the seed values.
- All errors are returned as JSON: `{ "error": "..." }`.

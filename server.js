import "dotenv/config";
import express from "express";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 5000;

function requestTimer(req, res, next) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
}

app.use(morgan("dev"));
app.use(requestTimer);
app.use(express.json());

app.get("/api/hello", (req, res) => {
  res.json({ message: "hello" });
});

let tasks = [
  { id: 1, title: "Buy groceries", done: false },
  { id: 2, title: "Write report", done: true },
  { id: 3, title: "Walk the dog", done: false },
];

app.get("/tasks", (req, res) => {
  res.json(tasks);
});

app.get("/tasks/:id", (req, res) => {
  const task = tasks.find((t) => t.id === Number(req.params.id));
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(task);
});

app.post("/tasks", (req, res) => {
  if (!req.body.title) {
    return res.status(400).json({ error: "title is required" });
  }
  const task = {
    id: Date.now(),
    title: req.body.title,
    done: req.body.done ?? false,
  };
  tasks.push(task);
  res.status(201).json(task);
});

app.put("/tasks/:id", (req, res) => {
  const task = tasks.find((t) => t.id === Number(req.params.id));
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  Object.assign(task, req.body);
  res.json(task);
});

app.delete("/tasks/:id", (req, res) => {
  const exists = tasks.some((t) => t.id === Number(req.params.id));
  if (!exists) {
    return res.status(404).json({ error: "Task not found" });
  }
  tasks = tasks.filter((t) => t.id !== Number(req.params.id));
  res.status(204).end();
});

function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

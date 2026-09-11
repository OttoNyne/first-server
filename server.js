import express from "express";
import morgan from "morgan";
import { loadEnv, connectDB } from "./config/db.js";
import { requestTimer } from "./middleware/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { Task } from "./models/Task.js";

loadEnv();
await connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

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

app.get("/tasks", async (req, res) => {
  const filter = {};
  if (req.query.done !== undefined) {
    filter.done = req.query.done === "true";
  }
  const tasks = await Task.find(filter);
  res.json(tasks);
});

app.get("/tasks/:id", async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(task);
});

app.post("/tasks", async (req, res) => {
  console.log("req.body:", req.body);
  if (!req.body.title) {
    return res.status(400).json({ error: "title is required" });
  }
  const task = await Task.create(req.body);
  res.status(201).json(task);
});

app.put("/tasks/:id", async (req, res) => {
  const task = await Task.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(task);
});

app.delete("/tasks/:id", async (req, res) => {
  const task = await Task.findByIdAndDelete(req.params.id);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json({ message: "Task deleted" });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

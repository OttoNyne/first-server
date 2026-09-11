import dotenv from "dotenv";
import mongoose from "mongoose";

export function loadEnv() {
  dotenv.config();
}

export async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected successfully");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
  }
}

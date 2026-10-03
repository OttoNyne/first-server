import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtlCache } from "../utils/ttlCache.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createTtlCache", () => {
  it("remembers a value until it expires", () => {
    const cache = createTtlCache(1000);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe(42);
    vi.advanceTimersByTime(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0); // and tidies up after itself
  });

  it("returns undefined for what it doesn't hold, and can hold falsy values", () => {
    const cache = createTtlCache(1000);
    expect(cache.get("nope")).toBeUndefined();
    cache.set("zero", 0);
    expect(cache.get("zero")).toBe(0);
  });

  it("forgets one entry or everything on request", () => {
    const cache = createTtlCache(1000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });

  it("starts the clock again when a value is set again", () => {
    const cache = createTtlCache(1000);
    cache.set("a", 1);
    vi.advanceTimersByTime(800);
    cache.set("a", 2);
    vi.advanceTimersByTime(800);
    expect(cache.get("a")).toBe(2);
  });

  it("never grows past its limit, dropping the oldest first", () => {
    const cache = createTtlCache(1000, 3);
    for (const k of ["a", "b", "c", "d"]) cache.set(k, k);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe("d");
  });
});

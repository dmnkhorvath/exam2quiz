import { describe, it, expect, beforeEach } from "vitest";
import { getConfig, getRedisConfig } from "./index.js";

describe("getConfig", () => {
  beforeEach(() => {
    // Reset cached config by reimporting (config uses a module-level cache)
    // For tests, we rely on default values since no env vars are set
  });

  it("returns config with default values", () => {
    const config = getConfig();
    expect(config.REDIS_HOST).toBe("localhost");
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.API_HOST).toBe("0.0.0.0");
    expect(config.API_PORT).toBe(3000);
    expect(config.WORKER_CONCURRENCY).toBe(3);
    // Vitest sets NODE_ENV=test
    expect(config.NODE_ENV).toBe("test");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("returns the same instance on subsequent calls", () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });
});

describe("getRedisConfig", () => {
  it("returns Redis connection config", () => {
    const redis = getRedisConfig();
    expect(redis.host).toBe("localhost");
    expect(redis.port).toBe(6379);
    expect(redis.maxRetriesPerRequest).toBeNull();
  });

  it("returns undefined password when empty", () => {
    const redis = getRedisConfig();
    expect(redis.password).toBeUndefined();
  });
});

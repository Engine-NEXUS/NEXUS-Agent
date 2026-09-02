/**
 * Tests for the cache module.
 */

import { userKey, pubKey, searchKey, contentHash, prAnalysisKey, repoMetaKey } from "../cache";

describe("cache key namespacing", () => {
  test("userKey prefixes with u:userId:", () => {
    expect(userKey("user123", "pr:owner/repo:5")).toBe("u:user123:pr:owner/repo:5");
  });

  test("pubKey prefixes with pub:", () => {
    expect(pubKey("repo:owner/repo:meta")).toBe("pub:repo:owner/repo:meta");
  });

  test("searchKey produces deterministic hash for same query", () => {
    const k1 = searchKey("en", "what is quantum computing");
    const k2 = searchKey("en", "what is quantum computing");
    const k3 = searchKey("en", "what is quantum Computing");
    expect(k1).toBe(k2);       // same query → same key
    expect(k1).toBe(k3);       // case-insensitive
    expect(k1).toMatch(/^search:en:/);
  });

  test("searchKey differs for different queries", () => {
    const k1 = searchKey("en", "what is python");
    const k2 = searchKey("en", "what is java");
    expect(k1).not.toBe(k2);
  });

  test("prAnalysisKey includes user, repo, pr, and content hash", () => {
    const key = prAnalysisKey("user1", "owner/repo", 42, "abc123");
    expect(key).toBe("u:user1:pr:owner/repo:42:vabc123");
  });

  test("repoMetaKey is public (no user prefix)", () => {
    const key = repoMetaKey("owner", "repo");
    expect(key).toBe("pub:repo:owner:repo:meta");
  });
});

describe("contentHash", () => {
  test("produces deterministic hash", () => {
    const h1 = contentHash("hello world");
    const h2 = contentHash("hello world");
    expect(h1).toBe(h2);
  });

  test("differs for different content", () => {
    const h1 = contentHash("hello world");
    const h2 = contentHash("hello earth");
    expect(h1).not.toBe(h2);
  });

  test("handles empty string", () => {
    expect(contentHash("")).toBeDefined();
    expect(typeof contentHash("")).toBe("string");
  });
});

import { describe, it, expect } from "vitest";
import { isOriginAllowed, constantTimeEqual } from "@/lib/httpUtils";

/**
 * Origin policy hardening tests — mirrors _shared/http.ts logic
 * via the client-side pure copy in httpUtils.ts
 */

describe("Origin policy — hardening", () => {
  // Allowed origins
  it("allows trusted app host keydraft.app", () => {
    expect(isOriginAllowed("https://keydraft.app")).toBe(true);
  });
  it("allows trusted app host www.keydraft.app", () => {
    expect(isOriginAllowed("https://www.keydraft.app")).toBe(true);
  });
  it("allows trusted app host wyloni.app", () => {
    expect(isOriginAllowed("https://wyloni.app")).toBe(true);
  });
  it("allows trusted app host sottra.app", () => {
    expect(isOriginAllowed("https://sottra.app")).toBe(true);
  });
  it("allows trusted app host ueradar.com", () => {
    expect(isOriginAllowed("https://ueradar.com")).toBe(true);
    expect(isOriginAllowed("https://www.ueradar.com")).toBe(true);
  });
  it("allows UERADAR Lovable preview via *.lovable.app", () => {
    expect(isOriginAllowed("https://ueradar.lovable.app")).toBe(true);
  });
  it("allows lovable.app subdomain", () => {
    expect(isOriginAllowed("https://my-project.lovable.app")).toBe(true);
  });
  it("allows lovableproject.com subdomain", () => {
    expect(isOriginAllowed("https://abc.lovableproject.com")).toBe(true);
  });
  it("allows lovable.dev subdomain", () => {
    expect(isOriginAllowed("https://test.lovable.dev")).toBe(true);
  });
  it("allows localhost", () => {
    expect(isOriginAllowed("http://localhost:3000")).toBe(true);
  });
  it("allows 127.0.0.1", () => {
    expect(isOriginAllowed("http://127.0.0.1:5173")).toBe(true);
  });

  // Rejected origins
  it("rejects unknown domain", () => {
    expect(isOriginAllowed("https://malicious.com")).toBe(false);
  });
  it("rejects empty string", () => {
    expect(isOriginAllowed("")).toBe(false);
  });
  it("rejects similar-looking domain", () => {
    expect(isOriginAllowed("https://keydraft.app.evil.com")).toBe(false);
  });
  it("rejects subdomain impersonation of trusted host", () => {
    expect(isOriginAllowed("https://sottra.app.attacker.io")).toBe(false);
    expect(isOriginAllowed("https://ueradar.com.evil.com")).toBe(false);
  });

  // Server-to-server (no origin)
  it("isOriginAllowed returns false for absent origin (empty string)", () => {
    expect(isOriginAllowed("")).toBe(false);
  });

  // CORE_ALLOWED_ORIGINS simulation via allowedOrigins param
  it("accepts custom allowed origin via allowedOrigins param", () => {
    expect(isOriginAllowed("https://custom-tool.internal.io", ["https://custom-tool.internal.io"])).toBe(true);
  });
  it("accepts wildcard in allowedOrigins", () => {
    expect(isOriginAllowed("https://anything.com", ["*"])).toBe(true);
  });
  it("rejects when custom allowedOrigins does not include origin", () => {
    expect(isOriginAllowed("https://evil.com", ["https://good.com"])).toBe(false);
  });
});

describe("constantTimeEqual — hardening", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });
  it("returns false for different strings same length", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });
  it("returns false for different lengths", () => {
    expect(constantTimeEqual("short", "longer-string")).toBe(false);
  });
  it("returns true for empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

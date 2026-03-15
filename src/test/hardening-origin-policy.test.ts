import { describe, it, expect } from "vitest";
import { isOriginAllowed } from "@/lib/httpUtils";

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
  });

  // Server-to-server (no origin) — covered by enforceOriginPolicy returning null
  // Here we just verify isOriginAllowed rejects empty
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

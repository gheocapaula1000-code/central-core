import { describe, it, expect } from "vitest";
import { isOriginAllowed, constantTimeEqual } from "@/lib/httpUtils";

describe("isOriginAllowed", () => {
  it("accepts https://sottra.app", () => {
    expect(isOriginAllowed("https://sottra.app")).toBe(true);
  });
  it("accepts https://keydraft.app", () => {
    expect(isOriginAllowed("https://keydraft.app")).toBe(true);
  });
  it("accepts https://localhost:3000", () => {
    expect(isOriginAllowed("https://localhost:3000")).toBe(true);
  });
  it("rejects https://malicious.com", () => {
    expect(isOriginAllowed("https://malicious.com")).toBe(false);
  });
  it("accepts dominio lovable.app", () => {
    expect(isOriginAllowed("https://my-app.lovable.app")).toBe(true);
  });
  it("accepts https://sottra.lovable.app", () => {
    expect(isOriginAllowed("https://sottra.lovable.app")).toBe(true);
  });
  it("accepts https://ueradar.com and www", () => {
    expect(isOriginAllowed("https://ueradar.com")).toBe(true);
    expect(isOriginAllowed("https://www.ueradar.com")).toBe(true);
  });
  it("accepts https://ueradar.lovable.app via lovable suffix", () => {
    expect(isOriginAllowed("https://ueradar.lovable.app")).toBe(true);
  });
  it("returns false for empty string", () => {
    expect(isOriginAllowed("")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("secret123", "secret123")).toBe(true);
  });
  it("returns false for different strings", () => {
    expect(constantTimeEqual("secret123", "secret456")).toBe(false);
  });
  it("returns false for different lengths", () => {
    expect(constantTimeEqual("short", "muchlonger")).toBe(false);
  });
});

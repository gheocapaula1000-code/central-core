export async function callAnthropic(
  prompt: string,
  temperature: number,
  maxTokens: number,
): Promise<{ output: string; latencyMs: number }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");

  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const started = Date.now();

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const output = data?.content?.[0]?.text ?? "";
    if (!output) throw new Error("Anthropic returned empty content");
    return { output, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("Anthropic timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Anthropic vision call. Anthropic requires base64-encoded images (not https URLs).
 * If an https URL is provided, it is downloaded and converted to base64.
 */
export async function callAnthropicVision(
  prompt: string,
  imageUrls: string[],
  temperature: number,
  maxTokens: number,
): Promise<{ output: string; latencyMs: number }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  if (!imageUrls?.length) throw new Error("callAnthropicVision: no image URLs");

  const model = Deno.env.get("ANTHROPIC_VISION_MODEL")
    ?? Deno.env.get("ANTHROPIC_MODEL")
    ?? "claude-sonnet-4-5-20250929";

  const contentBlocks: Array<Record<string, unknown>> = [];
  for (const url of imageUrls.slice(0, 4)) {
    if (url.startsWith("data:")) {
      const match = url.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
      if (!match) continue;
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      });
    } else if (url.startsWith("http")) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const mt = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const b64 = btoa(bin);
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mt, data: b64 },
        });
      } catch { /* skip */ }
    }
  }
  if (!contentBlocks.length) throw new Error("Anthropic vision: no valid images");
  contentBlocks.push({ type: "text", text: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const started = Date.now();

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: contentBlocks }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic vision error ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const output = data?.content?.[0]?.text ?? "";
    if (!output) throw new Error("Anthropic vision returned empty content");
    return { output, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("Anthropic vision timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

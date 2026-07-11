/** Returns the configured OpenAI API key (server-side only). Empty string if missing. */
function getOpenAIKey(): string {
  return Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
}

/** Returns the configured OpenAI model. Defaults to gpt-5.4. */
function getOpenAIModel(): string {
  return Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4";
}

export async function callOpenAI(
  prompt: string,
  temperature: number,
  maxTokens: number,
): Promise<{ output: string; latencyMs: number }> {
  const key = getOpenAIKey();
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  const model = getOpenAIModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const started = Date.now();

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature,
        max_completion_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const output = data?.choices?.[0]?.message?.content ?? "";
    if (!output) throw new Error("OpenAI returned empty content");
    return { output, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("OpenAI timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function getOpenAIVisionModel(): string {
  return Deno.env.get("OPENAI_VISION_MODEL") ?? Deno.env.get("OPENAI_MODEL_VISION") ?? "gpt-4o";
}

/**
 * Vision call: accepts one or more image URLs (https or data: base64) plus a text prompt.
 * Returns the model's text output.
 */
export async function callOpenAIVision(
  prompt: string,
  imageUrls: string[],
  temperature: number,
  maxTokens: number,
): Promise<{ output: string; latencyMs: number }> {
  const key = getOpenAIKey();
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  if (!imageUrls?.length) throw new Error("callOpenAIVision: no image URLs");

  const model = getOpenAIVisionModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const started = Date.now();

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const url of imageUrls.slice(0, 4)) {
    content.push({ type: "image_url", image_url: { url, detail: "high" } });
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature,
        max_completion_tokens: maxTokens,
        messages: [{ role: "user", content }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI vision error ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const output = data?.choices?.[0]?.message?.content ?? "";
    if (!output) throw new Error("OpenAI vision returned empty content");
    return { output, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("OpenAI vision timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callAnthropic(
  prompt: string,
  temperature: number,
  maxTokens: number,
): Promise<{ output: string; latencyMs: number }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");

  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-haiku-20240307";
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

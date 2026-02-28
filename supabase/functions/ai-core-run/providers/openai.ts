export async function callOpenAI(
  prompt: string,
  temperature: number,
  maxTokens: number,
): Promise<{ output: string; latencyMs: number }> {
  const key = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
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
        max_tokens: maxTokens,
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

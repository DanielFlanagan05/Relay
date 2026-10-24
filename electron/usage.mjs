// Provider counters are optional. Never turn an absent measurement into zero.
const measured = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const fields = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
export function normalizeUsage(value) {
  if (!value) return null;
  const usage = Object.fromEntries(
    fields.filter((k) => measured(value[k])).map((k) => [k, value[k]]),
  );
  if (usage.input === undefined && usage.output === undefined) return null;
  if (measured(value.contextInput)) usage.contextInput = value.contextInput;
  if (["request", "turn"].includes(value.scope)) usage.scope = value.scope;
  return usage;
}
export function addUsage(total, value) {
  const usage = normalizeUsage(value);
  if (!usage) return total || null;
  const sum = { ...total };
  for (const key of fields)
    if (usage[key] !== undefined) sum[key] = (sum[key] ?? 0) + usage[key];
  return sum;
}
export function estimateOutputTokens(text) {
  return Math.ceil((text || "").length / 4);
}
// This is turn throughput, including prefill/tool execution, NOT engine decode speed.
export function finalizeRate({ turnOutput, generatedText, elapsedMs }) {
  if (!(elapsedMs > 250)) return {};
  if (measured(turnOutput))
    return { rate: turnOutput / (elapsedMs / 1000), estimated: false };
  const estimate = estimateOutputTokens(generatedText);
  return estimate > 0
    ? { rate: estimate / (elapsedMs / 1000), estimated: true }
    : {};
}
// Pi and Anthropic bill uncached input separately from cached input.
export function inclusiveInput(input, cacheRead, cacheWrite) {
  if (!measured(input)) return undefined;
  return (
    input +
    (measured(cacheRead) ? cacheRead : 0) +
    (measured(cacheWrite) ? cacheWrite : 0)
  );
}

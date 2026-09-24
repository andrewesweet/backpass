/**
 * Distilled traces are handed to a model the user configured, but they are still built
 * from raw session logs. Obvious secret shapes are redacted before that happens
 * (design section 9, privacy). This is a coarse net, not a guarantee: it catches the
 * common token formats and `KEY=value` assignments that show up in shell transcripts.
 */

const PATTERNS = [
  [/\b(sk-ant-[A-Za-z0-9_-]{16,})/g, "ANTHROPIC_KEY"],
  [/\b(sk-proj-[A-Za-z0-9_-]{16,})/g, "OPENAI_KEY"],
  [/\b(sk-or-v1-[A-Za-z0-9_-]{16,})/g, "OPENROUTER_KEY"],
  [/\b(sk-[A-Za-z0-9]{32,})/g, "API_KEY"],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "GITHUB_TOKEN"],
  [/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "SLACK_TOKEN"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "AWS_ACCESS_KEY_ID"],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "PRIVATE_KEY"],
  [
    // The identifier must END with the secret word: max_output_tokens,
    // prompt_tokens, token_count and similar telemetry names never match.
    // The value stops at whitespace, a quote, or a comma, so one argument in
    // `max_output_tokens:12000,yield_time_ms:1000` can never swallow the next.
    // Purely numeric values (counts, limits) are left alone by the callback.
    /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY))\s*[=:]\s*(?:"([^"]{8,})"|'([^']{8,})'|([^\s"',]{8,}))/gi,
    "ASSIGNMENT",
  ],
];

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const [pattern, label] of PATTERNS) {
    out = out.replace(pattern, (match, first, dq, sq, bare) => {
      if (label !== "ASSIGNMENT") return `[redacted:${label}]`;
      const second = dq ?? sq ?? bare;
      // A specific pattern above may already have replaced the value; keep its label.
      if (typeof second === "string" && second.startsWith("[redacted")) return match;
      // Counts and limits (auth_token: 12345678) are not secrets.
      if (typeof second === "string" && /^[0-9]+$/.test(second)) return match;
      return `${first}=[redacted]`;
    });
  }
  return out;
}

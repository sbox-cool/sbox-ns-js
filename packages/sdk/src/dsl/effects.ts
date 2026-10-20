import { RunCancelled } from "../endpoint/runtime.js";

// Performers for the declarative steps that reach outside the run: sleep and Discord webhooks. The interpreter names
// each effect and the runtime performs it, so these functions are the only place a run waits or sends.

export const MAX_SLEEP_MS = 300000;

// Discord's embed limits, from its embed object documentation. The reference applies the same cuts.
const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  total: 6000,
} as const;

const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_ERROR_BODY_MAX = 500;
const DISCORD_WEBHOOK_PREFIXES = ["https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/"] as const;

export interface DiscordField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: DiscordField[];
  timestamp: string;
}

export interface DiscordPayload {
  embeds: DiscordEmbed[];
}

export type WebhookResult = { ok: true; status: number } | { ok: false; status: number; error: string };

export function isDiscordWebhookUrl(url: unknown): url is string {
  return typeof url === "string" && DISCORD_WEBHOOK_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// Trims an embed to Discord's limits. Mirrors the reference: title and field text are cut first, trailing fields are
// dropped while the embed total is over the limit, and the description takes what budget remains.
export function fitEmbed(embed: DiscordEmbed): DiscordEmbed {
  const title = cut(embed.title, EMBED_LIMITS.title);
  const fields = embed.fields.slice(0, EMBED_LIMITS.fields).map((field) => ({
    name: cut(field.name, EMBED_LIMITS.fieldName),
    value: cut(field.value, EMBED_LIMITS.fieldValue),
    inline: field.inline,
  }));
  const used = (): number => title.length + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  while (EMBED_LIMITS.total - used() < 0 && fields.length > 0) fields.pop();
  const budget = Math.max(0, EMBED_LIMITS.total - used());
  const description = cut(embed.description, Math.min(EMBED_LIMITS.description, budget));
  return { ...embed, title, description, fields };
}

// Cuts to at most max UTF-16 units without leaving a lone high surrogate at the end.
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let length = Math.max(0, max);
  if (length > 0) {
    const last = text.charCodeAt(length - 1);
    if (last >= 0xd800 && last <= 0xdbff) length -= 1;
  }
  return text.slice(0, length);
}

// Waits for ms. Rejects with RunCancelled if the run's signal aborts first.
export function sleepFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RunCancelled());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RunCancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// POSTs the payload to a Discord webhook. A non-2xx response or a transport failure is a result, not an exception,
// matching the reference step: the endpoint continues and the step records ok=false. Only the run's own abort throws.
export async function postDiscordWebhook(
  url: string,
  payload: DiscordPayload,
  signal: AbortSignal | undefined,
): Promise<WebhookResult> {
  const signals = [AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)];
  if (signal !== undefined) signals.push(signal);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
    const text = await response.text();
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: text.slice(0, WEBHOOK_ERROR_BODY_MAX) };
  } catch (error) {
    if (signal?.aborted) throw new RunCancelled();
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

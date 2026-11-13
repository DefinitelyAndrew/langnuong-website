export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

function clip(value: string, max: number): string {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Best-effort Discord log. Never throws, so a Discord outage cannot block the
 * reservation/email action that triggered the log.
 */
export async function sendDiscordLog(
  webhookEnv: string,
  title: string,
  fields: DiscordField[],
  color = 0x492200,
): Promise<void> {
  const webhookUrl = Deno.env.get(webhookEnv);
  if (!webhookUrl) return;

  const payload = {
    username: "Lang Nuong Website",
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      title: clip(title, 256),
      color,
      timestamp: new Date().toISOString(),
      fields: fields
        .filter(field => field && field.name)
        .map(field => ({
          name: clip(field.name, 256),
          value: clip(field.value || "—", 1024),
          inline: Boolean(field.inline),
        }))
        .slice(0, 25),
    }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`Discord log failed (${webhookEnv}): ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error(`Discord log failed (${webhookEnv}):`, error);
  } finally {
    clearTimeout(timer);
  }
}

export const BRANCH_WEBHOOKS: Record<string, string> = {
  exclusive1: "DISCORD_WEBHOOK_EXCLUSIVE",
  langnuong1980s: "DISCORD_WEBHOOK_1980S",
  bodevegetarian: "DISCORD_WEBHOOK_BODE",
};

export const BRANCH_NAMES: Record<string, string> = {
  exclusive1: "Lang Nuong Vietnam BBQ & Exclusive",
  langnuong1980s: "Lang Nuong Vietnam 1980's",
  bodevegetarian: "Bo De Vegetarian",
};

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
 * Destination channels. Posting uses the bot token (DISCORD_BOT_TOKEN) by
 * default; a per-channel webhook still works if one is configured.
 */
export const DISCORD_CHANNELS = {
  "1980s": "1570820635582529720",
  exclusive: "1570822015659802746",
  bode: "1570822049608376360",
  marketing: "1570860955175489690",
  "reservation-email": "1570861070652936304",
  otp: "1570861246763372615",
  recaptcha: "1570861694219976704",
  visits: "1570861803087339607",
} as const;

export type DiscordChannel = keyof typeof DISCORD_CHANNELS;

const WEBHOOK_ENV: Record<DiscordChannel, string> = {
  "1980s": "DISCORD_WEBHOOK_1980S",
  exclusive: "DISCORD_WEBHOOK_EXCLUSIVE",
  bode: "DISCORD_WEBHOOK_BODE",
  marketing: "DISCORD_WEBHOOK_MARKETING",
  "reservation-email": "DISCORD_WEBHOOK_RESERVATION_EMAIL",
  otp: "DISCORD_WEBHOOK_OTP",
  recaptcha: "DISCORD_WEBHOOK_RECAPTCHA",
  visits: "DISCORD_WEBHOOK_VISITS",
};

export const BRANCH_CHANNELS: Record<string, DiscordChannel> = {
  exclusive1: "exclusive",
  langnuong1980s: "1980s",
  bodevegetarian: "bode",
};

export const BRANCH_NAMES: Record<string, string> = {
  exclusive1: "Lang Nuong Vietnam BBQ & Exclusive",
  langnuong1980s: "Lang Nuong Vietnam 1980's",
  bodevegetarian: "Bo De Vegetarian",
};

function embedPayload(title: string, fields: DiscordField[], color: number) {
  return {
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
}

/**
 * Best-effort Discord log. Never throws, so a Discord outage cannot block the
 * reservation/email action that triggered the log. Silently no-ops when neither
 * DISCORD_BOT_TOKEN nor that channel's webhook is configured.
 */
export async function sendDiscordLog(
  channel: DiscordChannel,
  title: string,
  fields: DiscordField[],
  color = 0x492200,
): Promise<void> {
  const webhookUrl = Deno.env.get(WEBHOOK_ENV[channel]);
  const botToken = Deno.env.get("DISCORD_BOT_TOKEN");
  const url = webhookUrl || (botToken ? `https://discord.com/api/v10/channels/${DISCORD_CHANNELS[channel]}/messages` : "");
  if (!url) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webhookUrl ? {} : { Authorization: `Bot ${botToken}` }),
      },
      body: JSON.stringify(embedPayload(title, fields, color)),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`Discord log failed (${channel}): ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error(`Discord log failed (${channel}):`, error);
  } finally {
    clearTimeout(timer);
  }
}

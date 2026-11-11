export async function callSupabaseRpc<T>(functionName: string, args: Record<string, unknown> = {}): Promise<T> {
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || secretKeyFromSupabaseSecretKeys();
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Supabase URL and an API secret key are required");
  }

  const response = await fetch(
    `${projectUrl.replace(/\/+$/, "")}/rest/v1/rpc/${encodeURIComponent(functionName)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) {
    throw new Error(`Supabase RPC ${functionName} failed (${response.status}): ${await response.text()}`);
  }
  return await response.json() as T;
}

function secretKeyFromSupabaseSecretKeys(): string | null {
  const value = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!value) return null;

  const keys: unknown = JSON.parse(value);
  if (
    typeof keys === "object" &&
    keys !== null &&
    "default" in keys &&
    typeof keys.default === "string"
  ) {
    return keys.default;
  }
  throw new Error("SUPABASE_SECRET_KEYS does not contain a default API secret key");
}

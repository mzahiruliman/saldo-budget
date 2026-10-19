import { validateState } from "./model.mjs";
import { createClient } from '@supabase/supabase-js';
export function budgetApi(client, userId, connection) {
  if (connection) {
    const authClient = client;
    client = createClient(connection.url, connection.key, {
      accessToken: async () => {
        const { data, error } = await authClient.auth.getSession();
        if (error || data.session?.user.id !== userId || !data.session.access_token)
          throw new Error('Session changed. Reopen your budget before saving.');
        return data.session.access_token;
      },
      global: { fetch: connection.fetch || ((...args) => fetch(...args)) },
    });
  }
  function check(row) {
    if (!row) return null;
    if (row.user_id !== userId)
      throw new Error("Cloud document owner mismatch.");
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !validateState(row.payload).valid
    )
      throw new Error(
        "Cloud budget data is invalid. Export your draft; do not overwrite it.",
      );
    return row;
  }
  return {
    async load() {
      const { data, error } = await client
        .from("budget_documents")
        .select("user_id,payload,revision,updated_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return check(data);
    },
    async write(payload, revision) {
      const v = validateState(payload);
      if (!v.valid) throw new Error(v.errors[0]);
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 1800000)
        throw new Error(
          "Budget exceeds the cloud size limit. Export a backup.",
        );
      const { data, error } = await client.rpc("save_budget", {
        p_payload: payload,
        p_expected_revision: revision,
      });
      if (error) throw error;
      const row = check(Array.isArray(data) ? data[0] : data);
      if (!row) throw new Error("Cloud save returned no confirmation.");
      return row;
    },
  };
}

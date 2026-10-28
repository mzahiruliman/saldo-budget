import { ownerClient } from "./supabase-api.mjs";
import { monthBounds, entryMonth } from "./tracker-model.mjs";
export function createTrackerApi(authClient, userId, connection) {
  const client = ownerClient(authClient, userId, connection);
  let active = true;
  const stops = new Set();
  const check = () => {
    if (!active) throw new Error("Session ended. Reopen Activity.");
  };
  const row = (r) => {
    if (!r || r.user_id !== userId)
      throw new Error("Transaction owner mismatch.");
    if (
      !["income", "expense", "transfer"].includes(r.type) ||
      !Number.isSafeInteger(r.amount_cents) ||
      r.amount_cents <= 0 ||
      r.amount_cents > 10000000000 ||
      r.currency !== "MYR"
    )
      throw new Error("Invalid transaction response.");
    entryMonth(r);
    return r;
  };
  async function rpc(name, args = {}) {
    check();
    const { data, error } = await client.rpc(name, args);
    check();
    if (error) throw new Error(error.message || "Tracker request failed");
    return data;
  }
  const checkedCursor = cursor => {
    if (!cursor || typeof cursor.id !== 'string' || !/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(cursor.id) || typeof cursor.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.occurred_at) || !Number.isFinite(Date.parse(cursor.occurred_at))) throw new Error('Invalid history cursor');
    // Preserve PostgreSQL microseconds: Date.toISOString() would round them away.
    return {occurred_at:cursor.occurred_at,id:cursor.id};
  };
  async function page(month, cursor = null) {
    check();
    const { start, end } = monthBounds(month);
    let query = client.from('transactions').select('*',{count:'exact'}).eq('user_id',userId).gte('entry_date',start).lt('entry_date',end);
    if (cursor !== null) {
      const c = checkedCursor(cursor);
      query = query.or(`occurred_at.lt.${c.occurred_at},and(occurred_at.eq.${c.occurred_at},id.lt.${c.id})`);
    }
    const {data,error,count} = await query.order('occurred_at',{ascending:false}).order('id',{ascending:false}).range(0,50);
    check();
    if (error) throw new Error(error.message || 'History load failed');
    if (!Array.isArray(data)) throw new Error('Invalid history response');
    data.forEach(row);
    const entries=data.slice(0,50),hasMore=Number.isSafeInteger(count)?count>entries.length:data.length>50;
    return {entries,hasMore,nextCursor:hasMore?checkedCursor(entries.at(-1)):null};
  }
  return {
    metadata: () => rpc("tracker_metadata"),
    subscribe(callback, onStatus = () => {}) {
      check();
      let stopped = false;
      const channel = client
        .channel("saldo-transactions-" + userId + "-" + crypto.randomUUID())
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "transactions",
            filter: "user_id=eq." + userId,
          },
          () => {
            if (active && !stopped) callback();
          },
        );
      const stop = () => {
        if (stopped) return;
        stopped = true;
        stops.delete(stop);
        Promise.resolve(client.removeChannel(channel)).catch(() => {});
      };
      stops.add(stop);
      channel.subscribe((status) => {
        if (!active || stopped) return;
        onStatus(status);
        if (status === "SUBSCRIBED") callback();
      });
      return stop;
    },
    async exportAll() {
      const rows = await rpc("export_transactions");
      if (!Array.isArray(rows)) throw new Error("Invalid export response");
      return rows.map(row);
    },
    async devices() {
      const list = await rpc("list_shortcut_devices");
      if (!Array.isArray(list)) throw new Error("Invalid device list");
      return list.map((d) =>
        Object.fromEntries(
          [
            "id",
            "name",
            "time_zone",
            "expires_at",
            "revoked_at",
            "last_used_at",
            "created_at",
          ].map((k) => [k, d[k]]),
        ),
      );
    },
    async mint({ name, timeZone, days }) {
      check();
      name = String(name || "").trim();
      if (
        !name ||
        name.length > 80 ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > 365
      )
        throw new Error("Enter a device name and expiry from 1–365 days");
      new Intl.DateTimeFormat("en", { timeZone }).format();
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token =
        "sld_" +
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=/g, "");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token),
      );
      check();
      const hash = Array.from(new Uint8Array(digest), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("");
      const device = await rpc("create_shortcut_device", {
        p_name: name,
        p_token_hash: hash,
        p_time_zone: timeZone,
        p_expires_in_days: days,
      });
      if (!device?.id) throw new Error("Device creation was not acknowledged");
      return { device, token };
    },
    async revoke(id) {
      const result = await rpc("revoke_shortcut_device", { p_device_id: id });
      if (typeof result !== "boolean")
        throw new Error("Device revocation was not acknowledged");
      return result;
    },
    list: page,
    async create(entry) {
      if (
        !entry ||
        !Number.isSafeInteger(entry.amount_cents) ||
        entry.amount_cents <= 0 ||
        entry.amount_cents > 10000000000 ||
        !["income", "expense", "transfer"].includes(entry.type)
      )
        throw new Error("Invalid transaction");
      const result = await rpc("record_transaction", {
        p_entry: structuredClone(entry),
      });
      if (typeof result?.duplicate !== "boolean")
        throw new Error("Save was not acknowledged");
      row(result.transaction);
      return result;
    },
    async assign(id, { accountId, category = null }) {
      if (typeof accountId !== "string" || !accountId)
        throw new Error("Choose an owned account");
      return row(
        await rpc("assign_transaction", {
          p_transaction_id: id,
          p_account_id: accountId,
          p_category: category,
        }),
      );
    },
    async void(id) {
      const result = await rpc("void_transaction", { p_transaction_id: id });
      row(result);
      if (!result.voided_at) throw new Error("Void was not acknowledged");
      return result;
    },
    async summary(month) {
      monthBounds(month);
      const data = await rpc("tracker_summary", { p_month: month });
      for (const key of ["income_cents", "expense_cents", "transfer_cents"])
        if (!Number.isSafeInteger(data?.[key]))
          throw new Error("Invalid summary response");
      return data;
    },
    destroy() {
      active = false;
      for (const stop of [...stops]) stop();
      stops.clear();
    },
  };
}

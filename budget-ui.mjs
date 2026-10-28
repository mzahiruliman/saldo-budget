import {
  initialState,
  summarize,
  categoryTotals,
  routes,
  nextMonth,
  validateMonth,
  validateState,
  money,
} from "./model.mjs";
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
export function mountBudget({ initial, onChange, onView = () => {} }) {
  const root = document.querySelector("#workspace");
  const $ = s => root.querySelector(s);
  let alive = true, toastTimer;
  let state = structuredClone(initial),
    view = "budget",
    filter = "all",
    query = "";
  const month = () => state.months[state.selected],
    cats = ["commitment", "entertainment", "savings"],
    title = (s) => s.charAt(0).toUpperCase() + s.slice(1),
    fmt = (n) => money(n).replace("RM ", ""),
    account = (id) => state.accounts.find((a) => a.id === id)?.name || id;
  function toast(text) {
    if (!alive) return;
    $("#toast").textContent = text;
    $("#toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (alive) $("#toast").classList.remove("show"); }, 3200);
  }
  function save() {
    if (!alive) return;
    const v = validateState(state);
    if (!v.valid) {
      toast("Not saved: " + v.errors[0]);
      return;
    }
    onChange(structuredClone(state));
  }
  function modal(html) {
    if (!alive) return;
    $("#modal-content").innerHTML = html;
    $("#modal").showModal();
    $("#modal")
      .querySelector("[data-close]")
      ?.addEventListener("click", () => $("#modal").close());
  }
  function options(selected) {
    return state.accounts
      .map(
        (a) =>
          `<option value="${esc(a.id)}" ${a.id === selected ? "selected" : ""}>${esc(a.name)}</option>`,
      )
      .join("");
  }
  function render() {
    if (!alive) return;
    const m = month(),
      s = summarize(m),
      totals = categoryTotals(m);
    $("#month").value = state.selected;
    document
      .querySelectorAll("nav button")
      .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#page-name").textContent =
      view === "budget"
        ? "Monthly budget"
        : view === "accounts"
          ? "Accounts & routes"
          : view === "activity" ? "Activity" : "Plan settings";
    onView(view, state);
    if (view === "activity") return;
    if (view !== "budget") {
      renderOther();
      return;
    }
    $("#content").innerHTML =
      `<div class="title-row"><div><div class="eyebrow">THE MONTHLY PICTURE</div><h1>Your month, accounted for.</h1><p class="subtitle">A little clarity for your commitments, your good times, and what's next.</p></div><button id="edit-income">Edit income ↗</button></div>
 <div class="overview"><section class="income"><div class="income-top"><span class="eyebrow">AVAILABLE TO PLAN</span><button id="income-button" aria-label="Edit salary">Salary details ↗</button></div><div class="income-main"><small>RM</small><span data-testid="net">${fmt(s.net)}</span></div><div class="income-note">After setting aside ${m.motherPercent}% for Ibu. Family comes first.</div><div class="income-bottom"><div>Monthly salary<strong>RM ${fmt(m.salary)}</strong></div><div>Ibu · ${m.motherPercent}%<strong>− RM ${fmt(s.mother)}</strong></div><div>Salary account<strong>${esc(account(m.salaryAccount))}</strong></div></div></section><section class="remaining"><div class="eyebrow">${s.unallocated < 0 ? "OVER YOUR AVAILABLE INCOME" : "STILL YOURS TO ASSIGN"}</div><div class="value ${s.unallocated < 0 ? "negative" : ""}">RM ${fmt(s.unallocated)}</div><p>${s.unallocated < 0 ? "Your planned items exceed your available income." : "A little breathing room in this month’s plan."}</p><div class="balance-footer"><span>${m.items.length} planned items</span><span>RM ${fmt(s.allocated)} allocated</span></div></section></div>
 <section class="allocation">${cats
   .map((c) => {
     const share = s.net ? (totals[c] / s.net) * 100 : 0;
     return `<div class="category-card ${c}"><div class="category-top"><span><i class="cat-dot cat-${c}"></i>${title(c)}</span><span class="percent">${s.net ? share.toFixed(1) + "%" : "—"}</span></div><div class="cat-value">${fmt(totals[c])}<small>MYR</small></div><div class="progress"><span style="width:${Math.min(100, share)}%"></span></div><div class="cat-caption"><span>Actual share of net income</span><span>Target ${m.targets[c]}%</span></div></div>`;
   })
   .join("")}</section>
 <div class="section-title"><div><h2>The monthly breakdown</h2><p>Every ringgit has a place. Make yours work for you.</p></div><button id="add-item" class="primary">＋ Add item</button></div><section class="ledger"><div class="toolbar"><div class="tabs">${["all", ...cats].map((c) => `<button data-filter="${c}" class="${filter === c ? "selected" : ""}">${c === "all" ? "All items" : title(c)}</button>`).join("")}</div><input class="search" aria-label="Search budget items" placeholder="Search your items…" value="${esc(query)}"></div><div class="table-wrap"><table><thead><tr><th style="width:40px">Paid</th><th>Item / purpose</th><th>Category</th><th>Payment type</th><th>Money route</th><th>Amount (RM)</th><th></th></tr></thead><tbody id="rows"></tbody></table></div><div class="table-footer"><span id="item-count"></span><span>All amounts in MYR · Check cloud status</span></div></section><div class="legend"><span><i class="dot"></i>Pink = paid by credit card</span><span><i class="dot purple"></i>Purple = monthly subscription</span><span>✓ Check an item when paid</span></div><div class="review-note"><strong>Your plan, your choices.</strong> Import your existing backup to migrate. Account routes and balances are planning inputs, not verified bank transactions. ${Math.abs(s.targetTotal - 100) > 0.01 ? `Your targets add up to ${s.targetTotal}% — they are guidance, not spending limits.` : "Category percentages use income after Ibu’s deduction."}</div>`;
    $("#edit-income").onclick = editIncome;
    $("#income-button").onclick = editIncome;
    renderRows();
    $("#add-item").onclick = () => editItem();
    document.querySelectorAll("[data-filter]").forEach(
      (b) =>
        (b.onclick = () => {
          filter = b.dataset.filter;
          render();
        }),
    );
    $(".search").oninput = (e) => {
      query = e.target.value;
      renderRows();
    };
  }
  function renderRows() {
    const list = month().items.filter(
      (i) =>
        (filter === "all" || i.category === filter) &&
        i.name.toLowerCase().includes(query.toLowerCase()),
    );
    $("#rows").innerHTML =
      list
        .map(
          (i) =>
            `<tr><td><input class="paid-check" type="checkbox" aria-label="Mark ${esc(i.name)} paid" data-paid="${esc(i.id)}" ${i.paid ? "checked" : ""}></td><td><span class="item-name">${esc(i.name)}</span>${i.review ? `<span class="item-note">${i.amount === 0 ? "Amount needs review" : "Route needs review"}</span>` : ""}</td><td><span class="tag ${i.category === "entertainment" ? "orange" : i.category === "savings" ? "blue" : ""}">${title(i.category)}</span></td><td>${i.credit ? '<span class="tag pink">Credit card</span>' : ""} ${i.subscription ? '<span class="tag purple">Subscription</span>' : ""}${!i.credit && !i.subscription ? '<span class="item-note">Bank / cash</span>' : ""}</td><td class="route-cell">${esc(account(i.from))} <span>→</span> ${esc(account(i.to))}</td><td class="money">${fmt(i.amount)}</td><td><button class="row-edit" data-edit="${esc(i.id)}" aria-label="Edit ${esc(i.name)}">↗</button></td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="7" class="empty">No items match. Try a different search or add an item.</td></tr>';
    $("#item-count").textContent =
      `${list.length} of ${month().items.length} items`;
    document
      .querySelectorAll("[data-edit]")
      .forEach((b) => (b.onclick = () => editItem(b.dataset.edit)));
    document.querySelectorAll("[data-paid]").forEach(
      (b) =>
        (b.onchange = () => {
          month().items.find((i) => i.id === b.dataset.paid).paid = b.checked;
          save();
        }),
    );
  }
  function editIncome() {
    const m = month();
    modal(
      `<h2>A new number, a fresh plan.</h2><p class="subtitle">Only this month's income changes.</p><form id="income-form"><label for="salary">Monthly salary (RM)</label><input id="salary" type="number" min="0" max="100000000" step="0.01" value="${m.salary / 100}" required><label for="mother">Ibu deduction (%)</label><input id="mother" type="number" min="0" max="100" step="0.01" value="${m.motherPercent}" required><label for="salary-account">Salary received in</label><select id="salary-account">${options(m.salaryAccount)}</select><label for="mother-account">Send Ibu's allocation to</label><select id="mother-account">${options(m.motherAccount)}</select><div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary">Save income</button></div></form>`,
    );
    $("#income-form").onsubmit = (e) => {
      e.preventDefault();
      m.salary = Math.round(Number($("#salary").value) * 100);
      m.motherPercent = Number($("#mother").value);
      m.salaryAccount = $("#salary-account").value;
      m.motherAccount = $("#mother-account").value;
      save();
      $("#modal").close();
      render();
    };
  }
  function renderOther() {
    if (view === "settings") {
      renderSettings();
      return;
    }
    const m = month(),
      plan = routes(m),
      transfers = m.transfers || [],
      opening = m.openingBalances || {};
    const balances = state.accounts.filter(
      (a) => a.type !== "external" && a.type !== "recipient",
    );
    $("#content").innerHTML =
      `<div class="title-row"><div><div class="eyebrow">FOLLOW YOUR MONEY</div><h1>A home for every ringgit.</h1><p class="subtitle">Your accounts, planned payments, and the transfers that connect them.</p></div><button class="primary" id="add-account" aria-label="Add account">＋ Add account</button></div><div class="review-note" style="margin:0 0 20px">These are <strong>planning projections, not live balances</strong>. Enter each account's opening balance for this month, then add any funding transfers. Budget allocations include paid and unpaid items. A credit-card flag does not add a second card repayment.</div><div class="account-grid">${balances
        .map((a) => {
          const balance = Object.hasOwn(opening, a.id) ? opening[a.id] : null;
          let change = a.id === m.salaryAccount ? m.salary : 0;
          for (const r of [...plan, ...transfers]) {
            if (r.from === a.id) change -= r.amount;
            if (r.to === a.id) change += r.amount;
          }
          const projected = balance === null ? null : balance + change;
          return `<section class="account" data-account="${esc(a.id)}"><h3 aria-label="${esc(a.name)}">${esc(a.name)} <span class="tag">${esc(a.type)}</span></h3><p>Projected after this month's plan</p><strong class="${projected !== null && projected < 0 ? "negative" : ""}">${projected === null ? "Not set" : money(projected)}</strong><p>Opening: ${balance === null ? "not entered" : money(balance)}<br>Planned net change: ${money(change)}</p><button data-balance="${esc(a.id)}" aria-label="Edit ${esc(a.name)} balance">${balance === null ? "Set opening balance" : "Edit opening balance"} ↗</button></section>`;
        })
        .join(
          "",
        )}</div><div class="section-title routes-title"><div><h2>Funding transfers</h2><p>Move money between your accounts without counting it as spending.</p></div><button id="add-transfer" aria-label="Add transfer">＋ Add transfer</button></div><section class="ledger"><div class="table-wrap"><table><thead><tr><th>From</th><th>To</th><th>Amount (RM)</th><th></th></tr></thead><tbody>${transfers.map((t) => `<tr><td>${esc(account(t.from))}</td><td>${esc(account(t.to))}</td><td class="money">${fmt(t.amount)}</td><td><button class="row-edit" data-remove-transfer="${esc(t.id)}" aria-label="Remove transfer ${esc(account(t.from))} to ${esc(account(t.to))}">×</button></td></tr>`).join("") || '<tr><td colspan="4" class="empty">No funding transfers yet. Add only the transfers you plan to make.</td></tr>'}</tbody></table></div></section><div class="section-title routes-title"><div><h2>Where the budget goes</h2><p>Grouped allocations, including Ibu. Review each inferred route before using it.</p></div></div><section class="ledger"><div class="table-wrap"><table><thead><tr><th>From account</th><th>To account / payee</th><th>For</th><th>Amount (RM)</th></tr></thead><tbody>${plan.map((r) => `<tr><td>${esc(account(r.from))}</td><td>${esc(account(r.to))}</td><td style="white-space:normal;max-width:340px;line-height:1.7">${r.items.map(esc).join(", ")}</td><td class="money">${fmt(r.amount)}</td></tr>`).join("")}</tbody></table></div></section>`;
    $("#add-account").onclick = addAccount;
    $("#add-transfer").onclick = addTransfer;
    document
      .querySelectorAll("[data-balance]")
      .forEach((b) => (b.onclick = () => editBalance(b.dataset.balance)));
    document.querySelectorAll("[data-remove-transfer]").forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.removeTransfer;
          modal(
            '<h2>Remove this funding transfer?</h2><p class="subtitle">Only this month’s projection will change.</p><div class="form-actions"><button data-close>Cancel</button><button class="primary" id="confirm-transfer-delete">Confirm deletion</button></div>',
          );
          $("#confirm-transfer-delete").onclick = () => {
            m.transfers = m.transfers.filter((t) => t.id !== id);
            save();
            $("#modal").close();
            render();
          };
        }),
    );
  }
  function addAccount() {
    modal(
      `<h2>Add a home for your money.</h2><form id="account-form"><label for="account-name">Account name</label><input id="account-name" maxlength="70" required><label for="account-type">Account type</label><select id="account-type"><option value="bank">Bank</option><option value="wallet">Wallet</option><option value="investment">Investment</option><option value="cash">Cash</option><option value="card">Credit card</option></select><div id="account-error" class="form-error"></div><div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary">Save account</button></div></form>`,
    );
    $("#account-form").onsubmit = (e) => {
      e.preventDefault();
      const name = $("#account-name").value.trim();
      if (
        !name ||
        state.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())
      ) {
        $("#account-error").textContent = "Enter a unique account name.";
        return;
      }
      state.accounts.push({
        id: crypto.randomUUID(),
        name,
        type: $("#account-type").value,
        balance: null,
      });
      save();
      $("#modal").close();
      render();
    };
  }
  function editBalance(id) {
    const m = month(),
      a = state.accounts.find((a) => a.id === id),
      balance = m.openingBalances?.[id];
    modal(
      `<h2>${esc(a.name)} · opening balance</h2><p class="subtitle">For ${esc(state.selected)} only. Leave blank if unknown. Use a negative value for a card balance you owe.</p><form id="balance-form"><label for="balance-input">Opening balance (RM)</label><input id="balance-input" type="number" min="-100000000" max="100000000" step="0.01" value="${balance == null ? "" : balance / 100}"><div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary">Save balance</button></div></form>`,
    );
    $("#balance-form").onsubmit = (e) => {
      e.preventDefault();
      m.openingBalances ??= {};
      m.openingBalances[id] =
        $("#balance-input").value === ""
          ? null
          : Math.round(Number($("#balance-input").value) * 100);
      save();
      $("#modal").close();
      render();
    };
  }
  function addTransfer() {
    modal(
      `<h2>Connect your accounts.</h2><p class="subtitle">A planned transfer, not a new expense. No money is moved by this app.</p><form id="transfer-form"><label for="transfer-from">Transfer from</label><select id="transfer-from">${options(month().salaryAccount)}</select><label for="transfer-to">Transfer to</label><select id="transfer-to">${options(month().salaryAccount)}</select><label for="transfer-amount">Transfer amount (RM)</label><input id="transfer-amount" type="number" min="0.01" max="100000000" step="0.01" required><div class="form-error" id="transfer-error"></div><div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary">Save transfer</button></div></form>`,
    );
    $("#transfer-form").onsubmit = (e) => {
      e.preventDefault();
      const from = $("#transfer-from").value,
        to = $("#transfer-to").value;
      if (from === to) {
        $("#transfer-error").textContent = "Choose two different accounts.";
        return;
      }
      month().transfers ??= [];
      month().transfers.push({
        id: crypto.randomUUID(),
        from,
        to,
        amount: Math.round(Number($("#transfer-amount").value) * 100),
      });
      save();
      $("#modal").close();
      render();
    };
  }
  function renderSettings() {
    const m = month(),
      s = summarize(m),
      totals = categoryTotals(m);
    $("#content").innerHTML =
      `<div class="title-row"><div><div class="eyebrow">YOUR PLAN, YOUR RULES</div><h1>Room to change your mind.</h1><p class="subtitle">Targets guide your plan. They never lock your spending amounts.</p></div></div><section class="panel settings-form"><h2>Category targets</h2><p class="subtitle" style="margin:10px 0 18px">Percentages are based on RM ${fmt(s.net)} after Ibu. Adjust them each month; they do not have to total 100%.</p><form id="targets-form">${cats.map((c) => `<label for="target-${c}">${title(c)} target (%)</label><input id="target-${c}" type="number" min="0" max="100" step="0.01" value="${m.targets[c]}" required>`).join("")}<p id="target-total" class="review-note">Targets total: ${s.targetTotal}%</p><div class="form-actions"><button type="button" id="match-actual">Use current actual shares</button><button class="primary">Save targets</button></div></form></section><section class="panel settings-form"><h2>Targets versus the plan</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th>Target amount</th><th>Planned</th><th>Difference</th></tr></thead><tbody>${cats
        .map((c) => {
          const target = Math.round((s.net * m.targets[c]) / 100);
          return `<tr><td>${title(c)}</td><td>${money(target)}</td><td>${money(totals[c])}</td><td class="${target < totals[c] ? "negative" : ""}">${money(target - totals[c])}</td></tr>`;
        })
        .join(
          "",
        )}</tbody></table></div><p class="subtitle" style="margin-top:15px">Positive difference means room below the target. Negative means above it. Unallocated income is not automatically relabelled as savings.</p></section><section class="panel settings-form"><h2>Your data stays with you.</h2><p class="subtitle" style="margin:10px 0 17px">Saved to your signed-in cloud account when the status confirms it. Pending edits may be cached in this browser. Backups contain private budget data; keep them out of the public repository.</p><button id="settings-export">↓ Export backup</button> <button id="settings-import">↑ Import backup</button><p class="subtitle" style="margin-top:17px">New months copy your selected plan, reset payment checkmarks, and require fresh opening balances. Changes never rewrite an existing month.</p></section>`;
    $("#targets-form").onsubmit = (e) => {
      e.preventDefault();
      m.targets = Object.fromEntries(
        cats.map((c) => [c, Number($(`#target-${c}`).value)]),
      );
      save();
      render();
      toast("Targets saved. Your item amounts are unchanged.");
    };
    $("#match-actual").onclick = () => {
      for (const c of cats)
        $(`#target-${c}`).value = (
          s.net ? (totals[c] / s.net) * 100 : 0
        ).toFixed(2);
      $("#target-total").textContent =
        `Targets total: ${Number(cats.reduce((sum, c) => sum + Number($(`#target-${c}`).value), 0).toFixed(2))}%`;
    };
    $("#settings-export").onclick = () => exportBackup();
    $("#settings-import").onclick = () => $("#import").click();
  }
  function editItem(id) {
    const m = month(),
      existing = m.items.find((i) => i.id === id),
      i = existing || {
        name: "",
        amount: 0,
        category: "commitment",
        from: m.salaryAccount,
        to: "external",
        credit: false,
        subscription: false,
        paid: false,
        review: false,
        note: "",
      };
    modal(
      `<h2>${existing ? "A place for every ringgit." : "Give it a place."}</h2><p class="subtitle">Plan the amount, the category, and where it comes from.</p><form id="item-form"><label for="item-name">Item name</label><input id="item-name" maxlength="100" value="${esc(i.name)}" required><div class="two"><div><label for="item-amount">Amount (RM)</label><input id="item-amount" type="number" min="0" max="100000000" step="0.01" value="${i.amount / 100}" required></div><div><label for="item-category">Category</label><select id="item-category">${cats.map((c) => `<option value="${c}" ${c === i.category ? "selected" : ""}>${title(c)}</option>`).join("")}</select></div></div><div class="two"><div><label for="item-from">From account</label><select id="item-from">${options(i.from)}</select></div><div><label for="item-to">To account</label><select id="item-to">${options(i.to)}</select></div></div><label class="check-label"><input id="item-credit" type="checkbox" ${i.credit ? "checked" : ""}>Paid by credit card</label><label class="check-label"><input id="item-sub" type="checkbox" ${i.subscription ? "checked" : ""}>Monthly subscription</label><label class="check-label"><input id="item-review" type="checkbox" ${i.review ? "checked" : ""}>Needs review (amount or route)</label><label for="item-note">Notes</label><input id="item-note" maxlength="600" value="${esc(i.note)}"><div class="form-error" id="item-error"></div><div class="form-actions">${existing ? '<button class="danger" id="delete-item" type="button">Delete item</button>' : ""}<button type="button" data-close>Cancel</button><button class="primary">Save item</button></div></form>`,
    );
    $("#item-form").onsubmit = (e) => {
      e.preventDefault();
      const name = $("#item-name").value.trim();
      if (!name) {
        $("#item-error").textContent = "Enter an item name.";
        return;
      }
      const updated = {
        ...i,
        id: existing?.id || crypto.randomUUID(),
        name,
        amount: Math.round(Number($("#item-amount").value) * 100),
        category: $("#item-category").value,
        from: $("#item-from").value,
        to: $("#item-to").value,
        credit: $("#item-credit").checked,
        subscription: $("#item-sub").checked,
        review: $("#item-review").checked,
        note: $("#item-note").value.trim(),
      };
      if (existing) m.items[m.items.indexOf(existing)] = updated;
      else m.items.push(updated);
      save();
      $("#modal").close();
      render();
      toast("Item saved.");
    };
    if (existing)
      $("#delete-item").onclick = () => {
        $("#modal").close();
        modal(
          `<h2>Remove ${esc(existing.name)}?</h2><p class="subtitle">This removes the item from this month only.</p><div class="form-actions"><button data-close>Keep item</button><button class="primary" id="confirm-delete">Confirm deletion</button></div>`,
        );
        $("#confirm-delete").onclick = () => {
          m.items = m.items.filter((x) => x.id !== id);
          save();
          $("#modal").close();
          render();
          toast("Item removed.");
        };
      };
  }
  function exportBackup() {
    if (!alive) return;
    const blob = new Blob([JSON.stringify(state, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `saldo-backup-${state.selected}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("#export").onclick = exportBackup;
  $("#import").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (file.size > 1800000) throw new Error("Backup exceeds 1.8 MB.");
      const text = await file.text();
      if (!alive) return;
      const data = JSON.parse(text), validation = validateState(data);
      if (!validation.valid)
        throw new Error(validation.errors.slice(0, 2).join("; "));
      modal(
        `<h2>Restore this backup?</h2><p class="subtitle">This replaces your selected cloud budget with ${Object.keys(data.months).length} saved month(s). Export your current plan first if you want to keep it.</p><div class="form-actions"><button type="button" id="export-before-import">Export current</button><button data-close>Cancel</button><button class="primary" id="replace-backup">Replace with backup</button></div>`,
      );
      $("#export-before-import").onclick = exportBackup;
      $("#replace-backup").onclick = () => {
        if (!alive) return;
        state = data;
        filter = "all";
        query = "";
        save();
        $("#modal").close();
        render();
        toast("Backup restored.");
      };
    } catch (error) {
      toast(`Invalid backup: ${error.message}`);
    }
  };
  $("#month").onchange = (e) => {
    if (!/^\d{4}-\d{2}$/.test(e.target.value)) {
      render();
      return;
    }
    state = nextMonth(state, e.target.value);
    save();
    render();
  };
  function shiftMonth(delta) {
    const [y, m] = state.selected.split("-").map(Number),
      date = new Date(Date.UTC(y, m - 1 + delta, 1)),
      key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    state = nextMonth(state, key);
    save();
    render();
  }
  $("#month-prev").onclick = () => shiftMonth(-1);
  $("#month-next").onclick = () => shiftMonth(1);
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        view = b.dataset.view;
        render();
      }),
  );
  render();
  return {
    destroy() {
      alive = false;
      clearTimeout(toastTimer);
      $("#modal")?.close();
      root.querySelectorAll("*").forEach(node => {
        for (const event of ["onclick", "onchange", "oninput", "onsubmit"]) node[event] = null;
      });
    },
    setState(next) {
      if (!alive) return;
      const dialog = $("#modal");
      if (dialog.open) {
        dialog.close();
        toast("Budget data changed. Please reopen the editor.");
      }
      dialog.querySelectorAll("*").forEach(node => { node.onclick = node.onsubmit = null; });
      $("#modal-content").replaceChildren();
      state = structuredClone(next);
      render();
    },
    getState() {
      return structuredClone(state);
    },
    exportBackup,
  };
}

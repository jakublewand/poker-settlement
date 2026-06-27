const playersBody = document.querySelector("#players");
const rowTemplate = document.querySelector("#player-row-template");
const addButton = document.querySelector("#add-player");
const clearButtons = document.querySelectorAll(".clear-button");
const totalInEl = document.querySelector("#total-in");
const totalOutEl = document.querySelector("#total-out");
const mismatchEl = document.querySelector("#mismatch");
const mismatchLabelEl = document.querySelector("#mismatch-label");
const transfersEl = document.querySelector("#transfers");
const emptyStateEl = document.querySelector("#empty-state");
const transferCountEl = document.querySelector("#transfer-count");

const STORAGE_KEY = "poker-settlement-v1";
const EPSILON = 0.000001;

function centsFromInput(value) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function money(cents, { signed = false } = {}) {
  const sign = cents < 0 ? "-" : signed && cents > 0 ? "+" : "";
  const abs = Math.abs(cents);
  const value = abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2);
  return `${sign}${value}:-`;
}

function addRow(player = {}) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".name-input").value = player.name ?? "";
  row.querySelector(".buyin-input").value = player.buyIn ? (player.buyIn / 100).toFixed(2) : "";
  row.querySelector(".final-input").value = player.finalCount ? (player.finalCount / 100).toFixed(2) : "";
  row.querySelector(".remove-button").addEventListener("click", () => {
    row.remove();
    if (!playersBody.children.length) addRow();
    calculate();
  });
  row.addEventListener("input", calculate);
  playersBody.append(row);
  calculate();
}

function readPlayers() {
  return [...playersBody.querySelectorAll("tr")].map((row, index) => ({
    row,
    name: row.querySelector(".name-input").value.trim() || `Player ${index + 1}`,
    buyIn: centsFromInput(row.querySelector(".buyin-input").value),
    finalCount: centsFromInput(row.querySelector(".final-input").value),
  }));
}

function savePlayers(players) {
  const compact = players.map(({ name, buyIn, finalCount }) => ({ name, buyIn, finalCount }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
}

function allocateCents(total, entries) {
  const allocations = new Array(entries.length).fill(0);
  const weightTotal = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0 || weightTotal <= 0) return allocations;

  const cappedTotal = Math.min(total, entries.reduce((sum, entry) => sum + entry.cap, 0));
  let assigned = 0;
  const fractions = entries.map((entry, index) => {
    const exact = cappedTotal * entry.weight / weightTotal;
    const floor = Math.min(Math.floor(exact), entry.cap);
    allocations[index] = floor;
    assigned += floor;
    return { index, fraction: exact - floor };
  });

  fractions.sort((a, b) => b.fraction - a.fraction);
  let remaining = cappedTotal - assigned;
  while (remaining > 0) {
    let changed = false;
    for (const item of fractions) {
      if (remaining <= 0) break;
      if (allocations[item.index] >= entries[item.index].cap) continue;
      allocations[item.index] += 1;
      remaining -= 1;
      changed = true;
    }
    if (!changed) break;
  }

  return allocations;
}

function buildSettlement(players, totalIn, totalOut) {
  const difference = totalOut - totalIn;
  const countError = Math.abs(difference);
  const rows = players.map((player, index) => ({
    index,
    name: player.name,
    buyIn: player.buyIn,
    finalCount: player.finalCount,
    rawNet: player.finalCount - player.buyIn,
    countLoss: 0,
    adjustedFinal: player.finalCount,
    adjustedNet: 0,
  }));

  const allocations = allocateCents(
    countError,
    rows.map((row) => ({
      weight: row.finalCount,
      cap: difference > 0 ? row.finalCount : countError,
    }))
  );

  rows.forEach((row, index) => {
    row.countLoss = allocations[index];
    row.adjustedFinal = difference > 0
      ? row.finalCount - row.countLoss
      : row.finalCount + row.countLoss;
    row.adjustedNet = row.adjustedFinal - row.buyIn;
  });

  const balances = rows
    .filter((row) => row.adjustedNet !== 0)
    .map((row) => ({ name: row.name, amount: row.adjustedNet }));

  return {
    rows,
    balances,
    countError,
    allocatedCountLoss: allocations.reduce((sum, amount) => sum + amount, 0),
  };
}

function groupBalancesExactly(balances) {
  const n = balances.length;
  if (n <= 1) return balances.length ? [balances] : [];
  if (n > 16) return [balances];

  const size = 1 << n;
  const sums = new Int32Array(size);
  const zero = new Uint8Array(size);

  for (let mask = 1; mask < size; mask += 1) {
    const bit = mask & -mask;
    const index = Math.log2(bit);
    sums[mask] = sums[mask ^ bit] + balances[index].amount;
    zero[mask] = sums[mask] === 0 ? 1 : 0;
  }

  const best = new Int16Array(size);
  const choice = new Int32Array(size);

  for (let mask = 1; mask < size; mask += 1) {
    let bestCount = zero[mask] ? 1 : -30000;
    let bestSubset = zero[mask] ? mask : 0;
    for (let sub = (mask - 1) & mask; sub; sub = (sub - 1) & mask) {
      if (!zero[sub]) continue;
      const candidate = 1 + best[mask ^ sub];
      if (candidate > bestCount) {
        bestCount = candidate;
        bestSubset = sub;
      }
    }
    best[mask] = bestCount;
    choice[mask] = bestSubset;
  }

  const groups = [];
  let mask = size - 1;
  while (mask) {
    const selected = choice[mask] || mask;
    groups.push(balances.filter((_, index) => selected & (1 << index)));
    mask ^= selected;
  }
  return groups;
}

function settleGroup(group) {
  const debtors = group
    .filter((item) => item.amount < 0)
    .map((item) => ({ name: item.name, amount: -item.amount }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = group
    .filter((item) => item.amount > 0)
    .map((item) => ({ name: item.name, amount: item.amount }))
    .sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const amount = Math.min(debtors[debtorIndex].amount, creditors[creditorIndex].amount);
    if (amount > 0) {
      transfers.push({
        from: debtors[debtorIndex].name,
        to: creditors[creditorIndex].name,
        amount,
      });
    }

    debtors[debtorIndex].amount -= amount;
    creditors[creditorIndex].amount -= amount;

    if (debtors[debtorIndex].amount === 0) debtorIndex += 1;
    if (creditors[creditorIndex].amount === 0) creditorIndex += 1;
  }

  return transfers;
}

function getTransfers(balances) {
  return groupBalancesExactly(balances).flatMap(settleGroup);
}

function renderTransfers(transfers) {
  transfersEl.innerHTML = "";
  transferCountEl.textContent = transfers.length;
  emptyStateEl.classList.toggle("hidden", transfers.length > 0);

  transfers.forEach((transfer) => {
    const item = document.createElement("li");
    item.innerHTML = `
      <div class="transfer-line">
        <span>${escapeHtml(transfer.from)} pays ${escapeHtml(transfer.to)}</span>
        <span class="transfer-amount">${money(transfer.amount)}</span>
      </div>
    `;
    transfersEl.append(item);
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[char]));
}

function renderPlayerResults(players, settlementRows) {
  players.forEach((player, index) => {
    const settlement = settlementRows[index];
    const lossEl = player.row.querySelector(".count-diff");
    const netEl = player.row.querySelector(".net-result");
    const countDiff = settlement.adjustedFinal - settlement.finalCount;

    lossEl.textContent = countDiff ? money(countDiff, { signed: true }) : "0:-";
    lossEl.classList.toggle("positive", countDiff > 0);
    lossEl.classList.toggle("negative", countDiff < 0);
    netEl.textContent = money(settlement.adjustedNet, { signed: true });
    netEl.classList.toggle("positive", settlement.adjustedNet > 0);
    netEl.classList.toggle("negative", settlement.adjustedNet < 0);
  });
}

function calculate() {
  const players = readPlayers();
  const totalIn = players.reduce((sum, player) => sum + player.buyIn, 0);
  const totalOut = players.reduce((sum, player) => sum + player.finalCount, 0);
  const settlement = buildSettlement(players, totalIn, totalOut);
  const transfers = getTransfers(settlement.balances);

  totalInEl.textContent = money(totalIn);
  totalOutEl.textContent = money(totalOut);
  mismatchLabelEl.textContent = totalOut > totalIn ? "Overcount" : totalOut < totalIn ? "Missing" : "Mismatch";
  mismatchEl.textContent = money(Math.abs(totalIn - totalOut));

  renderPlayerResults(players, settlement.rows);
  renderTransfers(transfers);
  savePlayers(players);
}

function loadSavedPlayers() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) {
      saved.forEach(addRow);
      return;
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }

  addRow();
}

addButton.addEventListener("click", () => {
  addRow();
  playersBody.lastElementChild.querySelector(".name-input").focus();
});

clearButtons.forEach((button) => {
  button.addEventListener("click", () => {
    playersBody.innerHTML = "";
    localStorage.removeItem(STORAGE_KEY);
    addRow();
  });
});

loadSavedPlayers();

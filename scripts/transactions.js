/**
 * Store transactions (PF2e) — buy/sell with real currency movement.
 *
 * Players cannot edit the store journal, so purchases are relayed over a
 * module socket to the active GM's client, which validates funds and stock,
 * moves coins and items, updates the store flag, and posts a receipt.
 * When the acting user IS a GM the transaction executes locally.
 */

const MODULE_ID = 'Pf2eStoreGenerator';
const FLAG_KEY  = 'store';
const SOCKET    = `module.${MODULE_ID}`;

/* ── currency helpers (PF2e coins objects) ────────────────── */

export function coinsToCp(coins) {
  if (!coins || typeof coins !== 'object') return 0;
  return (Number(coins.pp) || 0) * 1000
       + (Number(coins.gp) || 0) * 100
       + (Number(coins.sp) || 0) * 10
       + (Number(coins.cp) || 0);
}

export function cpToCoins(cp) {
  cp = Math.max(0, Math.round(cp));
  const coins = {};
  const gp = Math.floor(cp / 100);
  const sp = Math.floor((cp % 100) / 10);
  const c  = cp % 10;
  if (gp) coins.gp = gp;
  if (sp) coins.sp = sp;
  if (c)  coins.cp = c;
  return coins;
}

export function cpLabel(cp) {
  const coins = cpToCoins(cp);
  const parts = [];
  for (const d of ['pp', 'gp', 'sp', 'cp']) if (coins[d]) parts.push(`${coins[d]} ${d}`);
  return parts.length ? parts.join(', ') : 'free';
}

/** Parse a price label like "3 gp, 5 sp" back into copper (legacy snapshots). */
export function parsePriceLabelCp(label) {
  if (!label || label === '—') return 0;
  let cp = 0;
  const re = /(\d+)\s*(pp|gp|sp|cp)/gi;
  let m;
  while ((m = re.exec(String(label)))) {
    const mul = { pp: 1000, gp: 100, sp: 10, cp: 1 }[m[2].toLowerCase()];
    cp += Number(m[1]) * mul;
  }
  return cp;
}

/** Effective sale price in copper, after the store's price multiplier. */
export function effectiveCp(entry, store) {
  const baseCp = Number(entry.priceCp) || parsePriceLabelCp(entry.price);
  const mul = Number(store.priceMultiplier) || 1;
  return Math.max(0, Math.round(baseCp * mul));
}

async function deductCoins(actor, cp) {
  const inventory = actor.inventory;
  if (!inventory?.coins || inventory.coins.copperValue < cp) return false;
  return inventory.removeCoins({ cp }, { byValue: true });
}

async function addCoins(actor, cp) {
  await actor.inventory?.addCoins?.(cpToCoins(cp));
}

/* ── transaction execution (runs on a GM client) ──────────── */

function getStoreFlag(journal) { return journal?.getFlag?.(MODULE_ID, FLAG_KEY) || null; }

async function postReceipt(kind, { actor, itemName, storeName, cp }) {
  const verb = kind === 'buy' ? 'bought' : 'sold';
  const prep = kind === 'buy' ? 'from' : 'to';
  await ChatMessage.create({
    content: `<p class="cfer-store-receipt"><i class="fa-solid fa-coins"></i> <strong>${foundry.utils.escapeHTML(actor.name)}</strong> ${verb} <strong>${foundry.utils.escapeHTML(itemName)}</strong> ${prep} <strong>${foundry.utils.escapeHTML(storeName)}</strong> for <strong>${cpLabel(cp)}</strong>.</p>`,
  });
}

export async function executeBuy({ journalUuid, entryUuid, actorUuid }) {
  const journal = await fromUuid(journalUuid);
  const store = getStoreFlag(journal);
  if (!store) return { ok: false, message: 'Store not found.' };
  if (store.closed) return { ok: false, message: `${journal.name} is closed.` };

  const entry = (store.inventory || []).find(e => e.uuid === entryUuid);
  if (!entry || (Number(entry.qty) || 0) < 1) return { ok: false, message: 'That item is out of stock.' };

  const actor = await fromUuid(actorUuid);
  if (!actor) return { ok: false, message: 'Buyer actor not found.' };

  const cost = effectiveCp(entry, store);
  if (!(await deductCoins(actor, cost))) {
    return { ok: false, message: `${actor.name} cannot afford ${entry.name} (${cpLabel(cost)}).` };
  }

  const worldItem = await fromUuid(entry.uuid).catch(() => null);
  if (!worldItem) {
    await addCoins(actor, cost);
    return { ok: false, message: 'The stocked item no longer exists — purchase refunded.' };
  }

  const data = worldItem.toObject();
  delete data._id;
  delete data.folder;
  data.system = data.system || {};
  data.system.quantity = 1;
  await actor.createEmbeddedDocuments('Item', [data]);

  const inventory = foundry.utils.deepClone(store.inventory);
  const flagEntry = inventory.find(e => e.uuid === entryUuid);
  flagEntry.qty = (Number(flagEntry.qty) || 1) - 1;
  const next = flagEntry.qty < 1 ? inventory.filter(e => e.uuid !== entryUuid) : inventory;
  await journal.setFlag(MODULE_ID, FLAG_KEY, { ...store, inventory: next });

  await postReceipt('buy', { actor, itemName: entry.name, storeName: journal.name, cp: cost });
  return { ok: true, message: `Bought ${entry.name} for ${cpLabel(cost)}.` };
}

export async function executeSell({ journalUuid, itemUuid, actorUuid }) {
  const journal = await fromUuid(journalUuid);
  const store = getStoreFlag(journal);
  if (!store) return { ok: false, message: 'Store not found.' };
  if (store.closed) return { ok: false, message: `${journal.name} is closed.` };
  if (store.allowSelling === false) return { ok: false, message: `${journal.name} is not buying from adventurers.` };

  const item = await fromUuid(itemUuid);
  const actor = await fromUuid(actorUuid);
  if (!item || !actor) return { ok: false, message: 'Item or actor not found.' };

  const baseCp = coinsToCp(item.system?.price?.value);
  const rate = Number.isFinite(Number(store.sellRate)) ? Number(store.sellRate) : 0.5;
  const payout = Math.max(0, Math.round(baseCp * rate));

  // Move one unit into the store's folder as a world item.
  const data = item.toObject();
  delete data._id;
  data.system = data.system || {};
  data.system.quantity = 1;
  if (store.itemFolderId && game.folders.get(store.itemFolderId)) data.folder = store.itemFolderId;
  const worldItem = await Item.create(data);

  const qty = Number(item.system?.quantity) || 1;
  if (qty > 1) await item.update({ 'system.quantity': qty - 1 });
  else await item.delete();

  await addCoins(actor, payout);

  const inventory = foundry.utils.deepClone(store.inventory || []);
  inventory.push({
    uuid:    worldItem.uuid,
    name:    worldItem.name,
    img:     worldItem.img || 'icons/svg/item-bag.svg',
    type:    worldItem.type,
    level:   Number(worldItem.system?.level?.value) || 0,
    price:   cpLabel(baseCp),
    priceCp: baseCp,
    qty:     1,
  });
  await journal.setFlag(MODULE_ID, FLAG_KEY, { ...store, inventory });

  await postReceipt('sell', { actor, itemName: worldItem.name, storeName: journal.name, cp: payout });
  return { ok: true, message: `Sold ${worldItem.name} for ${cpLabel(payout)}.` };
}

/* ── special orders ───────────────────────────────────────── */

/** Order fee (percent on top of the adjusted price) for un-stocked items. */
export function orderFeePct(store) {
  const f = Number(store?.orderFeePct);
  return Number.isFinite(f) && f >= 0 ? f : 10;
}

export async function executeOrder({ journalUuid, itemUuid, actorUuid }) {
  const journal = await fromUuid(journalUuid);
  const store = getStoreFlag(journal);
  if (!store) return { ok: false, message: 'Store not found.' };
  if (store.closed) return { ok: false, message: `${journal.name} is closed.` };

  const source = await fromUuid(itemUuid).catch(() => null);
  if (!source) return { ok: false, message: 'That item could not be found in the catalog.' };
  const actor = await fromUuid(actorUuid);
  if (!actor) return { ok: false, message: 'Buyer actor not found.' };

  const baseCp = coinsToCp(source.system?.price?.value);
  const mul = Number(store.priceMultiplier) || 1;
  const cost = Math.max(0, Math.round(baseCp * mul * (1 + orderFeePct(store) / 100)));
  if (!(await deductCoins(actor, cost))) {
    return { ok: false, message: `${actor.name} cannot afford to order ${source.name} (${cpLabel(cost)}).` };
  }

  const orders = foundry.utils.deepClone(store.orders || []);
  orders.push({
    id:        `ord-${foundry.utils.randomID(8)}`,
    uuid:      itemUuid,
    name:      source.name,
    img:       source.img || 'icons/svg/item-bag.svg',
    priceCp:   cost,
    buyerUuid: actor.uuid,
    buyerName: actor.name,
    placedAt:  Date.now(),
    status:    'ordered',
  });
  await journal.setFlag(MODULE_ID, FLAG_KEY, { ...store, orders });

  await ChatMessage.create({
    content: `<p class="cfer-store-receipt"><i class="fa-solid fa-scroll"></i> <strong>${foundry.utils.escapeHTML(actor.name)}</strong> placed a special order for <strong>${foundry.utils.escapeHTML(source.name)}</strong> at <strong>${foundry.utils.escapeHTML(journal.name)}</strong> (${cpLabel(cost)}, paid in advance).</p>`,
  });
  return { ok: true, message: `Ordered ${source.name} for ${cpLabel(cost)}.` };
}

export async function executeDeliverOrder({ journalUuid, orderId }) {
  const journal = await fromUuid(journalUuid);
  const store = getStoreFlag(journal);
  if (!store) return { ok: false, message: 'Store not found.' };
  const order = (store.orders || []).find(o => o.id === orderId);
  if (!order) return { ok: false, message: 'Order not found.' };

  const source = await fromUuid(order.uuid).catch(() => null);
  const buyer = await fromUuid(order.buyerUuid).catch(() => null);
  if (!source || !buyer) return { ok: false, message: 'The ordered item or its buyer no longer exists — cancel the order instead.' };

  const data = source.toObject();
  delete data._id;
  delete data.folder;
  data.system = data.system || {};
  data.system.quantity = 1;
  await buyer.createEmbeddedDocuments('Item', [data]);

  const orders = (store.orders || []).filter(o => o.id !== orderId);
  await journal.setFlag(MODULE_ID, FLAG_KEY, { ...store, orders });

  await ChatMessage.create({
    content: `<p class="cfer-store-receipt"><i class="fa-solid fa-box-open"></i> <strong>${foundry.utils.escapeHTML(order.name)}</strong> has arrived at <strong>${foundry.utils.escapeHTML(journal.name)}</strong> and was delivered to <strong>${foundry.utils.escapeHTML(order.buyerName)}</strong>.</p>`,
  });
  return { ok: true, message: `${order.name} delivered to ${order.buyerName}.` };
}

export async function executeCancelOrder({ journalUuid, orderId }) {
  const journal = await fromUuid(journalUuid);
  const store = getStoreFlag(journal);
  if (!store) return { ok: false, message: 'Store not found.' };
  const order = (store.orders || []).find(o => o.id === orderId);
  if (!order) return { ok: false, message: 'Order not found.' };

  const buyer = await fromUuid(order.buyerUuid).catch(() => null);
  if (buyer) await addCoins(buyer, Number(order.priceCp) || 0);

  const orders = (store.orders || []).filter(o => o.id !== orderId);
  await journal.setFlag(MODULE_ID, FLAG_KEY, { ...store, orders });

  await ChatMessage.create({
    content: `<p class="cfer-store-receipt"><i class="fa-solid fa-rotate-left"></i> The order for <strong>${foundry.utils.escapeHTML(order.name)}</strong> at <strong>${foundry.utils.escapeHTML(journal.name)}</strong> was cancelled${buyer ? ` — <strong>${foundry.utils.escapeHTML(order.buyerName)}</strong> was refunded ${cpLabel(order.priceCp)}` : ''}.</p>`,
  });
  return { ok: true, message: `Order cancelled${buyer ? ` and ${cpLabel(order.priceCp)} refunded` : ''}.` };
}

/* ── socket relay ─────────────────────────────────────────── */

const EXECUTORS = {
  buy:         executeBuy,
  sell:        executeSell,
  order:       executeOrder,
  deliverOrder: executeDeliverOrder,
  cancelOrder:  executeCancelOrder,
};

async function handleSocket(data) {
  if (data?.type === 'result') {
    if (data.userId === game.user.id) ui.notifications[data.ok ? 'info' : 'warn'](data.message);
    return;
  }
  // Only the designated active GM executes transactions.
  if (!game.users.activeGM?.isSelf) return;
  const executor = EXECUTORS[data?.type];
  if (!executor) return;
  const result = await executor(data);
  game.socket.emit(SOCKET, { type: 'result', userId: data.userId, ...result });
}

export function registerStoreSockets() {
  game.socket.on(SOCKET, data => { handleSocket(data).catch(err => console.error(`[${MODULE_ID}] socket transaction failed`, err)); });
}

/** Run a transaction: locally when GM, otherwise relayed to the active GM. */
export async function requestTransaction(payload) {
  const executor = EXECUTORS[payload.type];
  if (!executor) return { ok: false, message: `Unknown transaction: ${payload.type}` };
  if (game.user.isGM) {
    const result = await executor(payload);
    ui.notifications[result.ok ? 'info' : 'warn'](result.message);
    return result;
  }
  if (!game.users.activeGM) {
    ui.notifications.warn('A GM must be online to trade with stores.');
    return { ok: false, message: 'No GM online.' };
  }
  game.socket.emit(SOCKET, { ...payload, userId: game.user.id });
  return { ok: true, message: 'Request sent to the GM.' };
}

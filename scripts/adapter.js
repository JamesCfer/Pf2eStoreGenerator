/**
 * PF2e Store SystemAdapter — generates a complete store (shopkeeper, flavour,
 * and a stocked inventory) from a short description.
 *
 * The inventory items land in the world's Items directory inside a folder
 * named after the store; a JournalEntry ties the whole store together.
 *
 * @typedef {object} Pf2eStoreFormData
 * @property {string} name           Store name.
 * @property {string} storeType      One of the STORE_TYPE_LABELS keys.
 * @property {number} level          Typical item level of the stock (0–20).
 * @property {string} settlementSize Settlement size hint for stock breadth/wealth.
 * @property {string} description    Free-text description for the AI.
 */

import { SystemAdapter, postToN8n, ActorCreationError } from './core/adapter.js';
import { N8N_BASE, devUrl }          from './core/n8n.js';
import { detectModuleFolder,
         escapeHtml }                from './core/utils.js';
import { sanitizeItemDataPf2e,
         tryFixItemValidationError } from './sanitizer.js';

const MODULE_FOLDER  = detectModuleFolder('Pf2eStoreGenerator');
const STORE_ENDPOINT = `${N8N_BASE}/webhook/pf2e-store-builder`;

/** Monthly uses charged per store generation. */
export const STORE_COST = 7;

const STORE_TYPE_LABELS = {
  general:      'General Goods',
  blacksmith:   'Blacksmith / Weaponsmith',
  armorer:      'Armorer',
  alchemist:    'Alchemist / Apothecary',
  magic:        'Magic Shop',
  jeweler:      'Jeweler / Curiosities',
  fletcher:     'Fletcher / Bowyer',
  tavern:       'Tavern / Inn',
};

const SETTLEMENT_SIZE_LABELS = {
  village:    'Village',
  town:       'Town',
  city:       'City',
  metropolis: 'Metropolis',
};

export class Pf2eStoreAdapter extends SystemAdapter {
  get moduleFolder() { return MODULE_FOLDER; }

  get module() {
    return {
      id:           'Pf2eStoreGenerator',
      label:        'PF2e Store',
      icon:         'fa-solid fa-store',
      githubUrl:    'https://github.com/JamesCfer/Pf2eStoreGenerator',
      historyLabel: 'Created Stores',
    };
  }

  get systemId() { return 'pf2e'; }

  get formConfig() { return { documentNoun: 'store' }; }

  get progressSteps() {
    return ['Sending request…', 'Stocking the shelves…', 'Creating documents…'];
  }

  /* ── Form handling ──────────────────────────────────────── */

  /** @returns {Pf2eStoreFormData} */
  gatherFormData(form) {
    const fd = new FormData(form);
    const name           = (fd.get('name')?.toString()?.trim()) || 'Generated Store';
    const storeType      = (fd.get('storeType')?.toString() || 'general').trim();
    const level          = Number(fd.get('level')) || 1;
    const settlementSize = (fd.get('settlementSize')?.toString() || 'town').trim();
    const description    = (fd.get('description')?.toString()?.trim()) || '';

    if (!description) throw new Error('Please provide a description for the store.');
    return { name, storeType, level, settlementSize, description };
  }

  historyEntryFromForm(formData) {
    return {
      name:           formData.name,
      storeType:      formData.storeType,
      level:          formData.level,
      settlementSize: formData.settlementSize,
      description:    formData.description,
    };
  }

  historyMeta(entry) {
    const typeLabel = STORE_TYPE_LABELS[entry.storeType] || 'Store';
    return `Lv.&nbsp;${entry.level}&nbsp;·&nbsp;${typeLabel}`;
  }

  populateForm(form, entry) {
    const nameInput    = form.querySelector('[name="name"]');
    const typeSelect   = form.querySelector('[name="storeType"]');
    const levelInput   = form.querySelector('[name="level"]');
    const sizeSelect   = form.querySelector('[name="settlementSize"]');
    const descTextarea = form.querySelector('[name="description"]');
    if (nameInput)    nameInput.value    = entry.name ?? '';
    if (typeSelect)   typeSelect.value   = entry.storeType ?? 'general';
    if (levelInput)   levelInput.value   = entry.level ?? 1;
    if (sizeSelect)   sizeSelect.value   = entry.settlementSize ?? 'town';
    if (descTextarea) descTextarea.value = entry.description ?? '';
  }

  /* ── Generation ─────────────────────────────────────────── */

  /**
   * @param {import('./core/adapter.js').GenerateOptions & { formData: Pf2eStoreFormData }} opts
   * @returns {Promise<import('./core/adapter.js').AdapterResult>}
   */
  async generate({ formData, key, devMode }) {
    const endpoint = devUrl(STORE_ENDPOINT, devMode);
    const payload  = {
      name:           formData.name,
      storeType:      formData.storeType,
      level:          formData.level,
      settlementSize: formData.settlementSize,
      description:    formData.description,
    };

    const { response, responseText } = await postToN8n(endpoint, payload, key);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      throw new Error(`Invalid JSON response (${responseText.length} bytes): ${err.message}`);
    }

    if (!response.ok) throw new Error(data?.message || `Server returned status ${response.status}`);
    if (data?.ok === false) throw new Error(data?.message || data?.error || 'Server rejected the request');

    const store = data.store || data.foundryStore || data;
    if (!store || typeof store !== 'object') throw new Error('No valid store data returned from server');

    const inventory = Array.isArray(store.inventory) ? store.inventory
                    : Array.isArray(store.items)     ? store.items
                    : Array.isArray(data.foundryItems) ? data.foundryItems
                    : [];

    const storeName = store.name || formData.name;

    // Inventory items go into a folder named after the store.
    let folder = null;
    try {
      folder = await Folder.create({ name: storeName, type: 'Item' });
    } catch (_) { /* folderless creation still works */ }

    const createdItems = [];
    for (const rawItem of inventory) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      sanitizeItemDataPf2e(rawItem, null);
      if (folder) rawItem.folder = folder.id;

      let item = null, attempts = 0;
      while (!item && attempts < 10) {
        attempts++;
        try {
          item = await Item.create(rawItem);
        } catch (error) {
          const errorText = error.toString ? error.toString() : String(error.message || error);
          if (tryFixItemValidationError(rawItem, errorText)) continue;
          console.warn(`[${this.module.id}] Skipping rejected inventory item "${rawItem.name}": ${error.message}`);
          break;
        }
      }
      if (item) createdItems.push(item);
    }

    const journalData = {
      name: storeName,
      pages: [{
        name: 'Store Overview',
        type: 'text',
        text: { content: buildStoreJournalHtml(store, formData, createdItems), format: 1 },
      }],
    };
    // The store flag drives the custom store sheet (see store-sheet.js).
    journalData.flags = {
      [this.module.id]: {
        ...(folder?.id ? { itemFolderId: folder.id } : {}),
        store: {
          name:           storeName,
          storeType:      store.storeType || formData.storeType,
          settlementSize: store.settlementSize || formData.settlementSize,
          level:          formData.level,
          description:    store.description || formData.description,
          owner:          store.owner || store.shopkeeper || null,
          itemFolderId:   folder?.id || null,
          inventory:      createdItems.map(item => {
            const data = item.toObject ? item.toObject() : item;
            return {
              uuid:  item.uuid,
              name:  item.name,
              img:   item.img || 'icons/svg/item-bag.svg',
              type:  item.type,
              level: Number(data.system?.level?.value) || 0,
              price: priceLabel(data),
              priceCp: (v => (Number(v?.pp) || 0) * 1000 + (Number(v?.gp) || 0) * 100 + (Number(v?.sp) || 0) * 10 + (Number(v?.cp) || 0))(data.system?.price?.value),
              qty:   Math.max(1, Number(data.system?.quantity) || 1),
            };
          }),
        },
      },
    };

    let journal;
    try {
      journal = await JournalEntry.create(journalData);
    } catch (error) {
      throw new ActorCreationError(`Foundry rejected the store journal: ${error.message}`, store);
    }
    if (!journal) throw new ActorCreationError('Store journal creation returned null', store);

    return {
      document:   journal,
      exportData: {
        content:  JSON.stringify(store, null, 2),
        filename: `${storeName || 'store'}.json`,
        mimeType: 'application/json',
      },
      message: `Store "${storeName}" created with ${createdItems.length} item${createdItems.length === 1 ? '' : 's'} in stock!`,
    };
  }
}

/* ── Journal rendering helpers ───────────────────────────── */

/** Human-readable price for a PF2e item's data, or the entry's own price string. */
function priceLabel(itemData) {
  const p = itemData?.system?.price;
  if (typeof itemData?.price === 'string' && itemData.price) return itemData.price;
  const v = p?.value;
  if (v && typeof v === 'object') {
    const parts = [];
    for (const denom of ['pp', 'gp', 'sp', 'cp']) {
      if (Number(v[denom])) parts.push(`${Number(v[denom])} ${denom}`);
    }
    if (parts.length) return parts.join(', ');
  }
  if (typeof v === 'number' && v) return `${v} gp`;
  return '—';
}

function buildStoreJournalHtml(store, formData, createdItems) {
  const typeLabel = STORE_TYPE_LABELS[store.storeType || formData.storeType] || 'Store';
  const sizeLabel = SETTLEMENT_SIZE_LABELS[store.settlementSize || formData.settlementSize] || '';
  const owner     = store.owner || store.shopkeeper || null;

  const descHtml = store.description
    ? `<p>${escapeHtml(store.description)}</p>`
    : `<p>${escapeHtml(formData.description)}</p>`;

  const ownerHtml = owner
    ? `<h2>Shopkeeper</h2>
       <p><strong>${escapeHtml(owner.name || 'Unnamed shopkeeper')}</strong>${owner.ancestry || owner.race ? ` — ${escapeHtml(owner.ancestry || owner.race)}` : ''}</p>
       ${owner.description ? `<p>${escapeHtml(owner.description)}</p>` : ''}`
    : '';

  const rows = createdItems.map(item => {
    const data = item.toObject ? item.toObject() : item;
    return `<tr>
      <td>@UUID[${item.uuid}]{${escapeHtml(item.name)}}</td>
      <td style="text-align:center;">${Number(data.system?.level?.value) || 0}</td>
      <td style="text-align:right;">${escapeHtml(priceLabel(data))}</td>
    </tr>`;
  }).join('');

  const inventoryHtml = rows
    ? `<h2>Inventory</h2>
       <table>
         <thead><tr><th>Item</th><th>Level</th><th>Price</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>`
    : '<h2>Inventory</h2><p><em>No inventory items were created.</em></p>';

  return `
    <p><strong>${escapeHtml(typeLabel)}</strong>${sizeLabel ? ` · ${escapeHtml(sizeLabel)}` : ''}</p>
    ${descHtml}
    ${ownerHtml}
    ${inventoryHtml}`.trim();
}

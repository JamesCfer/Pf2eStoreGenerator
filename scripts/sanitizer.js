/**
 * Pathfinder 2e — Item data sanitization.
 *
 * Ensures a sane _id, the type matches one of the valid PF2e item types,
 * and any trait lists are arrays. The n8n pf2e-item-builder is expected
 * to produce mostly-valid data; this is a safety net.
 */

const VALID_ITEM_TYPES = new Set([
  'weapon', 'armor', 'equipment', 'consumable', 'treasure',
  'backpack', 'book', 'shield',
]);

export function sanitizeItemDataPf2e(itemData, requestedType) {
  const generateId = () => foundry.utils.randomID(16);

  if (!itemData._id || itemData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(itemData._id)) {
    itemData._id = generateId();
  }

  // Coerce type: prefer server-provided, fall back to what the user requested,
  // fall back to 'equipment' as a safe default.
  if (!VALID_ITEM_TYPES.has(itemData.type)) {
    if (requestedType && VALID_ITEM_TYPES.has(requestedType)) {
      itemData.type = requestedType;
    } else {
      itemData.type = 'equipment';
    }
  }

  if (!itemData.name) itemData.name = 'Unnamed Item';
  if (!itemData.img)  itemData.img  = 'icons/svg/item-bag.svg';

  if (!itemData.system) itemData.system = {};
  const s = itemData.system;

  if (s.traits && !Array.isArray(s.traits.value)) {
    s.traits.value = Array.isArray(s.traits) ? s.traits : [];
  }
  if (s.traits && !s.traits.rarity) s.traits.rarity = 'common';

  if (!s.description) s.description = { value: '', gm: '' };
  if (typeof s.description.value !== 'string') s.description.value = '';

  if (s.level && typeof s.level === 'number') s.level = { value: s.level };
  if (!s.level) s.level = { value: 0 };

  return itemData;
}

export function tryFixItemValidationError(itemData, errorMessage) {
  const invalidTraitMatch = errorMessage.match(/(\w+) is not a valid choice/);
  if (invalidTraitMatch) {
    const badTrait = invalidTraitMatch[1];
    if (itemData.system?.traits?.value && Array.isArray(itemData.system.traits.value)) {
      const before = itemData.system.traits.value.length;
      itemData.system.traits.value = itemData.system.traits.value.filter(
        t => t.toLowerCase() !== badTrait.toLowerCase()
      );
      return itemData.system.traits.value.length < before;
    }
  }

  const invalidTypeMatch = errorMessage.match(/"(\w+)" is not a valid type/);
  if (invalidTypeMatch && itemData.type === invalidTypeMatch[1]) {
    itemData.type = 'equipment';
    return true;
  }

  return false;
}

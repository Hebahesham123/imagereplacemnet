import assert from 'node:assert';
import { listImageSlots, replaceImageRef } from '../lib/templates.js';

const tpl = `/*
 * IMPORTANT: The contents of this file are auto-generated.
 */
{
  "sections": {
    "slideshow_ABC": {
      "type": "slideshow",
      "blocks": {
        "slide_1": { "type": "slide", "settings": { "image": "shopify://shop_images/FF_up_to_40__jpg.jpg", "image_mobile": "shopify://shop_images/FF_up_to_40__jpg.jpg", "link": "#" } }
      },
      "settings": {}
    },
    "custom_buttons": { "type": "custom-buttons", "settings": { "bg": "shopify://shop_images/16862.webp" } }
  },
  "order": ["slideshow_ABC", "custom_buttons"]
}`;

const slots = listImageSlots(tpl);
assert.equal(slots.length, 3);
assert.deepEqual(slots.map((s) => s.image), ['FF_up_to_40__jpg.jpg', 'FF_up_to_40__jpg.jpg', '16862.webp']);
assert.equal(slots[0].label, 'slideshow › slide › image');

const r = replaceImageRef(tpl, 'FF_up_to_40__jpg.jpg', 'winter_sale.jpg');
assert.equal(r.count, 2);
assert.ok(r.content.startsWith('/*'), 'header comment kept');
assert.ok(r.content.includes('"shopify://shop_images/16862.webp"'), 'other images untouched');
assert.equal(listImageSlots(r.content).filter((s) => s.image === 'winter_sale.jpg').length, 2);

// a filename that is a prefix of another must not be touched
const r2 = replaceImageRef('{"a":"shopify://shop_images/a.jpg","b":"shopify://shop_images/a.jpg.png"}', 'a.jpg', 'z.jpg');
assert.equal(r2.count, 1);
assert.ok(r2.content.includes('a.jpg.png'));

console.log('All template tests passed ✓');

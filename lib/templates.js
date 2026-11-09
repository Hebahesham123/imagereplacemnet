// Helpers for finding and replacing image references in Shopify JSON templates.
// Image picker settings are stored as "shopify://shop_images/<filename>".

const PREFIX = 'shopify://shop_images/';

// Shopify adds a /* ... */ comment at the top of templates saved by the theme editor.
function parseTemplate(content) {
  const stripped = content.replace(/^\s*\/\*[\s\S]*?\*\//, '');
  return JSON.parse(stripped);
}

// Returns [{ image, label, section, setting }] for every image setting in the template.
export function listImageSlots(content) {
  const slots = [];
  try {
    const tpl = parseTemplate(content);
    for (const [sid, sec] of Object.entries(tpl.sections || {})) {
      const scan = (settings = {}, where) => {
        for (const [key, val] of Object.entries(settings)) {
          if (typeof val === 'string' && val.startsWith(PREFIX)) {
            slots.push({ image: val.slice(PREFIX.length), section: sid, type: sec.type, setting: key, label: `${sec.type} › ${where ? where + ' › ' : ''}${key}` });
          }
        }
      };
      scan(sec.settings);
      for (const [bid, blk] of Object.entries(sec.blocks || {})) scan(blk.settings, blk.type || bid);
    }
  } catch {
    // Fallback: plain text scan if JSON is unusual
    for (const m of content.matchAll(/"([^"]+)"\s*:\s*"shopify:\/\/shop_images\/([^"]+)"/g)) {
      slots.push({ image: m[2], setting: m[1], label: m[1] });
    }
  }
  return slots;
}

// Exact string replace: keeps the file's formatting and header comment untouched.
export function replaceImageRef(content, oldFilename, newFilename) {
  const from = JSON.stringify(PREFIX + oldFilename);
  const to = JSON.stringify(PREFIX + newFilename);
  const count = content.split(from).length - 1;
  return { content: content.split(from).join(to), count };
}

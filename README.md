# Landing Image Swapper (Shopify)

Tick several landing pages → click the image they use → paste a new URL or upload a file → it's replaced in all of them at once. Every change is backed up and can be undone from the dashboard.

## 1. Create an Admin API token (one time)
Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app**
- Admin API scopes: `read_content`, `read_themes`, `write_themes`, `read_files`, `write_files`
- Install the app → copy the **Admin API access token** (`shpat_…`)

## 2. Run it
```bash
npm install
cp .env.example .env     # fill in SHOP and ADMIN_TOKEN
npm start                # open http://localhost:3000
```
Tip: set `THEME_ID` to a duplicate of your live theme first, test there, then clear it to edit the live theme.

## How it works
- Reads every page and its JSON template (`templates/page.<suffix>.json`).
- Finds all image-picker settings (`shopify://shop_images/...`) — slideshow images, mobile images, banners, etc.
- On apply: uploads the new image to **Content → Files**, then swaps the old filename for the new one in the selected templates only. Formatting is left as it is.
- Backups are saved in `backups/<timestamp>/` → **Undo** in the History panel.

## Important
- **Shared templates:** if two pages use the same template (e.g. survey1 + survey2 both on `page.survey`), changing one changes both. The dashboard shows a warning on those pages and in *Preview*. To change one page alone, give it its own template in the theme editor.
- Only images set via theme settings are found. Images hardcoded inside a `.liquid` file or in the page's rich-text body aren't changed.
- Don't host this publicly without setting `APP_PASSWORD`, because it holds your Admin token.

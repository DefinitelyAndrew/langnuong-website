# Làng Nướng Vietnam – Static Website

Mobile-first static clone of [langnuonggroup.com](https://langnuonggroup.com/) for GitHub Pages hosting.

## Pages

| File | Page |
|------|------|
| `index.html` | Group home page |
| `bbq.html` | Lang Nuong Vietnam BBQ |
| `1980s.html` | Lang Nuong Vietnam 1980's |
| `little-hanoi.html` | Little Hanoi |
| `style.css` | Shared mobile-first stylesheet |

## Deploy to GitHub Pages

### Option 1 — New repository

1. Create a new GitHub repository (e.g. `langnuong-website`)
2. From this folder, run:

```bash
git init
git add .
git commit -m "Initial commit – Lang Nuong Vietnam static site"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/langnuong-website.git
git push -u origin main
```

3. Go to **Settings → Pages** in your repo
4. Under **Source**, select **Deploy from a branch**
5. Choose **main** branch, **/ (root)** folder → click **Save**
6. Your site will be live at `https://YOUR_USERNAME.github.io/langnuong-website/`

### Option 2 — Custom domain

After deploying, add a `CNAME` file with your domain:

```
langnuong.example.com
```

Then configure your DNS A records to point to GitHub Pages IPs:
```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

## Local preview

Open any `.html` file directly in your browser, or use a local server:

```bash
# Python 3
python3 -m http.server 8000
# then open http://localhost:8000
```

## Notes

- All images are hotlinked from the original `langnuonggroup.com` CDN. No image files are bundled.
- WhatsApp reservation links use the `wa.me` shortlink format.
- Google Maps embeds are included on each location page.
- The site is fully static — no server, database, or build step required.

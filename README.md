# JSN AI Material

Material inventory management dashboard. Record Material In and Material Out entries; the stock balance updates automatically.

## Run it

Requires Python 3.9 or newer.

```bash
cd jsn-ai-material
python -m venv venv
# Windows:  venv\Scripts\activate
# Mac/Linux: source venv/bin/activate
pip install -r requirements.txt
python main.py
```

Open http://127.0.0.1:5000 and sign in:

- **User name:** `admin`
- **Password:** `Jsn*@2026`

## Features

- **Material stock available:** a colourful tile for each material with its balance, total in and total out. Tiles at 5 or less are tagged *Low stock*, and tiles at 0 are tagged *Out of stock*.
- **Material In:** material name, quantity and "in by" person are required. Remarks are optional.
- **Material Out:** pick from the materials currently in stock, then enter the quantity, out by, project and handover to (all required). You can't issue more than is available, and the server checks this too.
- **Recent movements:** the last 200 entries, filterable by In or Out.
- **Export CSV:** download every movement.
- The page refreshes every 15 seconds, so entries made by other users show up.

## Use it on your office network

To let other PCs on the same network open the dashboard:

```bash
# Windows (PowerShell)
$env:JSN_HOST="0.0.0.0"; python main.py
# Mac/Linux
JSN_HOST=0.0.0.0 python main.py
```

Then open `http://<this-PC's-IP>:5000` from the other PCs.

## Settings (optional environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `JSN_ADMIN_USER` | `admin` | Login user name |
| `JSN_ADMIN_PASS` | `Jsn*@2026` | Login password |
| `JSN_LOW_STOCK` | `5` | Low-stock threshold |
| `JSN_HOST` / `JSN_PORT` | `127.0.0.1` / `5000` | Address the server listens on |
| `JSN_DB_PATH` | `inventory.db` | Database file location |

## Data

All entries are stored in `inventory.db` (SQLite) next to `main.py`. It is created on first run. Back up this file to keep your records.

## Project layout

```
jsn-ai-material/
├── main.py              Flask server: login, API, stock calculation
├── requirements.txt
├── templates/
│   ├── login.html
│   └── dashboard.html
└── static/
    ├── style.css
    └── app.js
```
# JSN_Material_dashboard

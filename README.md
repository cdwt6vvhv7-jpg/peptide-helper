# Peptide Helper

A personal, local-only peptide research tracker — inventory and reconstitution math, per-subject dosing protocols (including multi-peptide blends), a printable calendar schedule, printable vial labels, and consumption reports.

No accounts, no cloud, no external services. Everything lives in a single file (`data.json`) on your own computer.

## What you'll need

- **Python 3** — already installed on macOS. On Windows/Linux, install it from [python.org](https://www.python.org/) if you don't have it (`python3 --version` to check).
- A modern browser (Chrome, Safari, Firefox, Edge).
- That's it — no other software, no package installs, no build step.

## Getting it

Clone this repo, or download it as a ZIP from GitHub and unzip it:

```bash
git clone https://github.com/cdwt6vvhv7-jpg/peptide-helper.git
```

## Running it

**macOS:** double-click `start.command`. It starts the server and opens the app in your browser automatically. Leave the terminal window it opens alone — closing it (or Ctrl+C) stops the app.

**Windows / Linux, or if you'd rather run it by hand:**

```bash
cd peptide-helper
python3 server.py
```

Then open **http://localhost:8765** in your browser.

**No-server option:** you can also just open `index.html` directly in a browser (double-click it). Everything still works, except your data is stored only in that browser's local storage instead of a `data.json` file — see [Your data](#your-data-and-privacy) below.

The first time it runs, it creates an empty `data.json` in this folder — that's your whole database, and it starts out blank.

## Setting up your data

You've got two ways to get started, and you can mix both:

**Click through the app.** Add yourself (and anyone else you're tracking for) in Settings, add your peptides in Inventory, then set up a dosing protocol for each one in Protocols. This is the normal way to go if you're just adding a peptide or two.

**Import a config file.** If you've got a bunch of peptides/protocols to set up at once, go to **Settings → Set up from a config file**, click **Download example file** to get a template, fill it in with your own subjects/peptides/protocols/starting inventory (referencing everything by name, not by any internal ID), and upload it back in. You'll get a preview ("2 subjects, 5 peptides...") to confirm before anything is written — and heads up, importing a config **replaces all current data**, so it's really meant for setting up a fresh install rather than editing one you're already using.

## A quick tour

- **Dashboard** — what's due today/this week/month, an "as-needed" quick-log section for PRN doses, an estimated "levels" graph if you've entered half-life data, and a stock-level overview.
- **Inventory** — your peptide library (including blends), restock lots, and on-hand stock (with quick +/- vial-count correction buttons).
- **Protocols** — each subject's dosing schedule: frequency, dose (with titration support), time of day, cycles (including auto-repeating on/off cycles), end dates.
- **Print Schedule** — a printable calendar of upcoming doses, checkbox-style.
- **Labels** — printable/exportable vial labels, sized for a NIIMBOT M2 label printer (or any printer via your browser's print dialog).
- **Reports** — consumption totals per substance over any date range, blends automatically split into their components.
- **Settings** — subjects, syringe type, label design, backup/restore, and the config import described above.

## Your data and privacy

- If you're running via `server.py` (the recommended way), your data lives in `data.json` in this folder — a real file, not tied to one browser. Back it up like any other file (copy it, put the whole folder in cloud storage, etc.).
- If you opened `index.html` directly with no server, your data lives only in that specific browser's local storage — export a backup from **Settings → Backup** regularly, since clearing browser data or switching browsers/devices will lose it.
- Nothing is ever sent anywhere. There's no server this talks to except the one running on your own machine.

## Label printing (optional)

If you don't have a NIIMBOT M2 label printer, ignore this — everything else works fine without it. If you do, see the **Labels** tab: you can either print through your browser (if the printer's registered as a normal printer) or export PNGs sized for the NIIMBOT app, either downloaded or written straight to a folder you choose in **Settings → Label design**.

## Troubleshooting

- **"Address already in use" / port 8765 busy** — something else is already using that port, likely a previous copy of `server.py` still running. Find and stop it (`lsof -i :8765` on macOS/Linux), then try again.
- **Changes aren't saving** — check the badge in the top-right of the app. It should say "Saving to data.json." If it says "Browser storage only," you're not running via the server (see [No-server option](#running-it) above) — either start the server, or make sure to export backups regularly.

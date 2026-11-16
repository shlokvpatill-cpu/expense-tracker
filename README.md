# Expense Tracker

An expense tracker I built for a restaurant, which they now use every day to run their accounts. It started as a simple way to note down the day's sales and expenses, and grew into a complete daily accounts app for the counter, on a Windows PC and an Android phone.

## What it does

- **Daily entry:** cash and online (UPI) sales, items sold, expenses with bill photos, staff bonuses, money taken by the owners and customer credit, filled in step by step with a progress strip that shows what's done for the day.
- **Dashboard:** today's net profit at a glance, where the money came from and went, and one list of everything that needs attention (vendor dues, credit to collect, salaries due, licences expiring, backups).
- **Vendors:** bills on credit, part payments and what's still pending to each supplier.
- **Staff:** monthly salaries, advances and daily bonuses.
- **Owners:** daily drawings, money spent from their own pocket, and each owner's month-end profit share.
- **Customer credit:** who owes what, with a full history and reminders.
- **Reports:** weekly, monthly and custom-range profit, with charts, printing and Excel export.
- **Bills & documents:** photos and PDFs of bills and licences, kept with the expense they belong to.
- **Backup and sync:** local backups, plus optional cloud sync between the PC and the phone (see [CLOUD-SETUP.md](CLOUD-SETUP.md)).
- Works offline, with a light and dark theme, keyboard shortcuts on the PC and a thumb-friendly layout on the phone.

## Built with

Plain HTML, CSS and JavaScript (no framework), packaged with [Electron](https://www.electronjs.org/) for Windows and [Capacitor](https://capacitorjs.com/) for Android. Optional sync uses [Supabase](https://supabase.com/).

## Running it

```bash
npm install
npm start            # run the Windows app
npm test             # automated checks of the main tasks (uses Microsoft Edge)
npm run build        # build the Windows app into dist/
npm run android      # build the signed Android APK (needs the Android SDK and your own signing key)
```

The app's design rules are in [DESIGN.md](DESIGN.md), and the logo files and usage guide are in [branding/](branding/).

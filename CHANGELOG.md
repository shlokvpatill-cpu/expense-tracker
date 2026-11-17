# Changelog

What changed in each version of the Expense Tracker. Newest first.

## 1.6.0 – 16 Nov 2026
**Faster expense entry**
- **"Usual" buttons** in Add expenses for the things bought most in the last 30 days (e.g. Chapati, Milk, Pav, Mutton). One tap adds a row with its category and vendor filled in. The buttons update by themselves as buying habits change.
- **Amount from quantity:** typing a quantity in the description, like "Chapati (400)", "8L Milk" or "Chicken 18kg", fills in the amount at the usual rate. The rate is learned from past purchases of a similar size, so a big daily order and a small top-up each get their own price.
- **Rate check:** a note appears when an amount is 15% or more off the usual rate, e.g. "₹6.5 each – usually ₹4.5 each (+44%)".
- **Duplicate warning:** saving the same item at the same amount twice on one day asks before adding it again.
- **Undo after deleting:** deletes happen straight away, with an Undo button for a few seconds instead of an "Are you sure?" pop-up. A deleted bill photo is only removed for good once Undo is gone.

## 1.5.1 – 16 Nov 2026
- **Menu items whose price changes every day** (e.g. fish at market price): tick "Price changes every day" on the item, and Daily Entry asks for today's price next to the quantity, filled in with the last price used.
- Each day's item sales are saved at that day's price; the menu list shows the last price used and its date.

## 1.5.0 – 16 Nov 2026
- **Weekly / Monthly / Custom range** picker on Expenses, Vendors, Customer Credit, Item Sales and Bills & Documents (Bills also has "All time"). Each page remembers its own period.
- **Automatic expense categories:** typing a description picks the category, first from how the same thing was filed before, then from common words (chicken, Pepsi, onion, gas, FSSAI…). A category picked by hand always wins.
- **New categories:** Chapati, Pav & Bhakri · Cold Drinks & Beverages · Kitchen Utensils & Equipment. Past expenses were sorted into them.
- **Enter key in Add expenses:** description → amount → next row.
- **Setting to hide keyboard shortcut hints** (Settings → General).

## 1.4.1 – 16 Nov 2026
- **Amount left after the owners' cut:** shown for today on the Dashboard, for this week and this month, and on Profit Reports.

## 1.4.0 – 11 Nov 2026
- **New Dashboard:** today's net profit as one big number, bars showing where the money came from and went, four quick buttons, and one "Needs attention" list (vendor dues, credit to collect, salaries due, licences expiring, backups).
- **New Daily Entry:** a progress strip showing which parts of the day are done, numbered sections with ticks, the day summary led by net profit, and a bar at the bottom of the phone screen with today's profit and a WhatsApp copy button.
- A design system (DESIGN.md) applied across all screens; thumb-sized controls on phones; small polish such as button press feedback.

## 1.3.6 – 11 Nov 2026
- **New logo and app icon** (a bowl whose steam rises as growing bars) on the Android launcher, splash screen, reminder notification, the Windows app and the sidebar.
- **Accessibility:** every box has a label, icon buttons have names, clickable rows work with the keyboard, a visible focus ring, bigger tap areas on phones, and no animations when the device asks for reduced motion.
- **Automated tests** (`npm test`) for the main tasks: daily sales, expenses, vendor bills and payments, customer credit and profit reports.

## 1.3.5
- The app as first put into daily use: daily sales and items, expenses with bill photos, vendors, helpers, owners' drawings and profit shares, customer credit, profit reports, Excel export, backups and cloud sync between the PC and the phone.

// Main tasks of the canteen app, checked the way you use them: typing in boxes and pressing buttons.
const { test, expect } = require('@playwright/test');

const TODAY = '2026-11-11T10:00:00+05:30';

// the big number on a summary tile, found by its heading
const tile = (scope, label) => scope.locator(
  `xpath=.//div[contains(concat(" ", normalize-space(@class), " "), " stat ")][div[@class="label" and normalize-space()="${label}"]]/div[@class="value"]`);

async function openPage(page, hash) {
  await page.goto('/index.html#' + hash);
  await expect(page.locator('#view')).not.toBeEmpty();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(TODAY));
  // the app must never reach the internet during tests (no cloud sync)
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4173)/, r => r.abort());
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => { throw e; });
});

async function addExpense(page, { desc, amount, vendor, paidNow }) {
  await openPage(page, 'expenses');
  await page.getByRole('button', { name: '+ Add expense' }).click();
  const modal = page.getByRole('dialog', { name: 'Add expenses' });
  const row = modal.locator('.bulk-row').first();
  await row.locator('[data-f=desc]').fill(desc);
  await row.locator('[data-f=amount]').fill(String(amount));
  if (vendor) {
    await row.locator('[data-f=vendorId]').selectOption({ label: vendor });
    if (paidNow != null) await row.locator('[data-f=paidNow]').fill(String(paidNow));
  }
  await modal.getByRole('button', { name: 'Save all' }).click();
  await expect(modal).toBeHidden();
}

async function addVendor(page, name) {
  await openPage(page, 'vendors');
  await page.getByRole('button', { name: '+ Add vendor' }).click();
  const modal = page.getByRole('dialog', { name: 'Add vendor' });
  await modal.getByLabel('Vendor name').fill(name);
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();
}

test('daily sales are saved and added up', async ({ page }) => {
  await openPage(page, 'daily');
  await page.getByLabel('Cash received from customers').fill('5000');
  await page.getByLabel('Online / UPI received').fill('2000');
  await page.getByRole('button', { name: 'Save sales' }).click();
  await expect(page.getByRole('status')).toHaveText('Sales saved');

  await openPage(page, 'dashboard');
  await expect(page.getByTestId('today-net')).toHaveText('₹7,000');
  await expect(page.getByTestId('today-sub')).toContainText('Business ₹7,000');
  await expect(page.getByRole('button', { name: /Today's entry.*Sales ✓/ })).toBeVisible();

  // still there after closing and reopening the app
  await page.reload();
  await expect(page.getByTestId('today-net')).toHaveText('₹7,000');
});

test('dashboard lists what needs attention and the daily steps show progress', async ({ page }) => {
  await addVendor(page, 'Ramesh Dairy');
  await addExpense(page, { desc: 'Paneer', amount: 1500, vendor: 'Ramesh Dairy', paidNow: 0 });
  await openPage(page, 'dashboard');
  const todo = page.locator('.todo');
  await expect(todo.getByText("Today's sales are not entered yet")).toBeVisible();
  await expect(todo.locator('li', { hasText: 'Pending to vendors' })).toContainText('₹1,500');
  await expect(page.getByTestId('today-net')).toHaveText('-₹1,500');

  // "Enter now" goes to today's Daily Entry, where Sales is the next step and Expenses is done
  await todo.locator('li', { hasText: "Today's sales" }).getByRole('button', { name: /Enter now/ }).click();
  await expect(page.locator('#pageTitle')).toHaveText('Daily Entry');
  const steps = page.getByRole('navigation', { name: 'Sections of the day' });
  await expect(steps.getByRole('button', { name: /Sales/ })).toHaveAttribute('aria-current', 'step');
  await expect(steps.getByRole('button', { name: /Expenses \(done\)/ })).toBeVisible();

  await page.getByLabel('Cash received from customers').fill('3000');
  await page.getByRole('button', { name: 'Save sales' }).click();
  await expect(steps.getByRole('button', { name: /Sales \(done\)/ })).toBeVisible();
  await expect(page.locator('#daySummary .hero-num')).toHaveText('₹1,500');
});

test('an expense shows in the list and the month total', async ({ page }) => {
  await addExpense(page, { desc: '20 L milk', amount: 800 });
  await expect(page.locator('#view table').getByText('20 L milk')).toBeVisible();
  await expect(tile(page, 'Total expenses')).toHaveText('₹800');
});

test('vendor bill on credit, then a part payment', async ({ page }) => {
  await addVendor(page, 'Ramesh Dairy');
  await addExpense(page, { desc: 'Paneer', amount: 1500, vendor: 'Ramesh Dairy', paidNow: 0 });

  await openPage(page, 'vendors');
  await page.getByRole('row', { name: /Ramesh Dairy/ }).getByText('Ramesh Dairy').click();
  const ledger = page.getByRole('dialog', { name: /Ramesh Dairy/ });
  await expect(tile(ledger, 'Pending')).toHaveText('₹1,500');

  await ledger.getByRole('button', { name: 'Record payment' }).click();
  const pay = page.getByRole('dialog', { name: 'Pay Ramesh Dairy' });
  await expect(pay.getByLabel('Amount paid *')).toHaveValue('1500');
  await pay.getByLabel('Amount paid *').fill('1000');
  await pay.getByRole('button', { name: 'Save' }).click();

  await expect(tile(page.getByRole('dialog', { name: /Ramesh Dairy/ }), 'Pending')).toHaveText('₹500');
});

test('customer credit and payment keep the right balance', async ({ page }) => {
  await openPage(page, 'credit');
  await page.getByRole('button', { name: '+ Add customer' }).click();
  const add = page.getByRole('dialog', { name: 'Add regular customer' });
  await add.getByLabel('Customer name *').fill('Suresh');
  await add.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('button', { name: '+ Credit', exact: true }).click();
  const credit = page.getByRole('dialog', { name: 'Give credit to Suresh' });
  await credit.getByLabel('Amount *').fill('300');
  await credit.getByLabel('What was taken').fill('Lunch for a week');
  await credit.getByRole('button', { name: 'Save' }).click();
  await expect(tile(page, 'Total to collect')).toHaveText('₹300');

  await page.getByRole('button', { name: 'Payment', exact: true }).click();
  const payment = page.getByRole('dialog', { name: 'Payment from Suresh' });
  await expect(payment.getByLabel('Amount *')).toHaveValue('300');
  await payment.getByLabel('Amount *').fill('100');
  await payment.getByRole('button', { name: 'Save' }).click();
  await expect(tile(page, 'Total to collect')).toHaveText('₹200');
  await expect(tile(page, 'Collected')).toHaveText('₹100');
});

test('profit report: sales minus expenses', async ({ page }) => {
  await openPage(page, 'daily');
  await page.getByLabel('Cash received from customers').fill('5000');
  await page.getByLabel('Online / UPI received').fill('2000');
  await page.getByRole('button', { name: 'Save sales' }).click();
  await expect(page.getByRole('status')).toHaveText('Sales saved');
  await addExpense(page, { desc: 'Gas cylinder', amount: 800 });

  await openPage(page, 'reports');
  await expect(tile(page, 'Business')).toHaveText('₹7,000');
  await expect(tile(page, 'All expenses')).toHaveText('₹800');
  await expect(tile(page, 'Net profit')).toHaveText('₹6,200');
  await expect(tile(page, 'Profit margin')).toHaveText('89%');
  await expect(tile(page, 'Left after owners')).toHaveText('₹6,200');
});

test('expenses, vendors, credit, items and bills follow the chosen period', async ({ page }) => {
  await addExpense(page, { desc: 'Gas cylinder', amount: 950 });
  const period = page.getByRole('group', { name: 'Period' });
  // this week: shown
  await period.getByRole('button', { name: 'Weekly' }).click();
  await expect(page.locator('#view table').getByText('Gas cylinder')).toBeVisible();
  await expect(tile(page, 'Total expenses')).toHaveText('₹950');
  // the week before: not shown
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(tile(page, 'Total expenses')).toHaveText('₹0');
  // custom range, last 30 days: shown again
  await period.getByRole('button', { name: 'Custom range' }).click();
  await page.getByLabel('Quick pick').selectOption({ label: 'Last 30 days' });
  await expect(tile(page, 'Total expenses')).toHaveText('₹950');
  // every other page has its own picker
  for (const hash of ['vendors', 'credit', 'items', 'bills']) {
    await openPage(page, hash);
    await expect(page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Custom range' })).toBeVisible();
  }
  await expect(page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
});

test('adding expenses: category follows the description, Enter goes description → amount → next row', async ({ page }) => {
  await openPage(page, 'expenses');
  await page.getByRole('button', { name: '+ Add expense' }).click();
  const modal = page.getByRole('dialog', { name: 'Add expenses' });
  const rows = modal.locator('.bulk-row');

  await rows.nth(0).locator('[data-f=desc]').fill('Chapati (350)');
  await expect(rows.nth(0).locator('[data-f=category]')).toHaveValue('Chapati, Pav & Bhakri');
  await rows.nth(0).locator('[data-f=desc]').press('Enter');
  await expect(rows.nth(0).locator('[data-f=amount]')).toBeFocused();
  await page.keyboard.type('350');
  await page.keyboard.press('Enter');
  await expect(rows.nth(1).locator('[data-f=desc]')).toBeFocused();

  // a category picked by hand is kept, whatever is typed after
  await rows.nth(1).locator('[data-f=category]').selectOption('Miscellaneous');
  await rows.nth(1).locator('[data-f=desc]').fill('Pepsi 2 box');
  await expect(rows.nth(1).locator('[data-f=category]')).toHaveValue('Miscellaneous');
  await rows.nth(2).locator('[data-f=desc]').fill('Pepsi 2 box');
  await expect(rows.nth(2).locator('[data-f=category]')).toHaveValue('Cold Drinks & Beverages');
});

test('shortcut hints can be hidden', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the phone app shows no shortcut hints');
  await openPage(page, 'dashboard');
  await expect(page.locator('#nav .key').first()).toBeVisible();
  await openPage(page, 'settings');
  await page.getByLabel(/Show keyboard shortcut hints/).uncheck();
  await expect(page.locator('#nav .key').first()).toBeHidden();
  await page.reload();
  await expect(page.locator('#nav .key').first()).toBeHidden();
});

test('amount left after the owners take their cut', async ({ page }) => {
  await openPage(page, 'owners');
  await page.getByRole('button', { name: '+ Add owner' }).click();
  const add = page.getByRole('dialog', { name: 'Add owner' });
  await add.getByLabel(/name/i).first().fill('Nitin');
  await add.getByLabel(/share/i).fill('100');
  await add.getByRole('button', { name: 'Save' }).click();

  await openPage(page, 'daily');
  await page.getByLabel('Cash received from customers').fill('5000');
  await page.getByRole('button', { name: 'Save sales' }).click();
  await expect(page.getByRole('status')).toHaveText('Sales saved');
  const took = page.locator('form[data-form=withdraw]');
  await took.getByLabel('Amount taken').fill('1500');
  await took.getByRole('button', { name: 'Add' }).click();

  await openPage(page, 'dashboard');
  await expect(page.getByTestId('today-left')).toContainText('Owners took ₹1,500 · ₹3,500 left in the business');
  const week = page.locator('.card', { hasText: 'This week' });
  await expect(week.locator('.period > div', { hasText: 'Left after owners' }).locator('.value')).toHaveText('₹3,500');
  await openPage(page, 'reports');
  await expect(tile(page, 'Left after owners')).toHaveText('₹3,500');
});

test('every button and box has a name screen readers can read', async ({ page }) => {
  await addVendor(page, 'Ramesh Dairy');
  // a filled-in day, so every Daily Entry step shows its "done" state
  await addExpense(page, { desc: 'Paneer', amount: 1500, vendor: 'Ramesh Dairy', paidNow: 0 });
  await openPage(page, 'daily');
  await page.getByLabel('Cash received from customers').fill('3000');
  await page.getByRole('button', { name: 'Save sales' }).click();
  await expect(page.getByRole('status')).toHaveText('Sales saved');
  for (const hash of ['dashboard', 'daily', 'expenses', 'vendors', 'helpers', 'owners', 'credit', 'items', 'bills', 'reports', 'settings']) {
    await openPage(page, hash);
    const unnamed = await page.evaluate(() => {
      const visible = el => el.offsetParent !== null || el.getClientRects().length > 0;
      // a box needs a label (or aria-label); a button needs text or aria-label
      const named = el => (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim() ||
        (el.tagName === 'BUTTON' && el.textContent.trim()) ||
        (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
      return [...document.querySelectorAll('button, input:not([type=hidden]), select, textarea')]
        .filter(el => visible(el) && !named(el))
        .map(el => el.outerHTML.slice(0, 120));
    });
    expect(unnamed, `on the ${hash} page`).toEqual([]);
    // nothing sticks out past the screen edge (that would zoom the whole page out on a phone)
    const tooWide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(tooWide, `page width on the ${hash} page`).toBeLessThanOrEqual(0);
  }
});

test('vendor list works with the keyboard alone', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard check is for the computer');
  await addVendor(page, 'Ramesh Dairy');
  await openPage(page, 'vendors');
  const row = page.getByRole('row', { name: /Ramesh Dairy/ });
  await row.focus();
  await page.keyboard.press('Enter');
  const ledger = page.getByRole('dialog', { name: /Ramesh Dairy/ });
  await expect(ledger).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ledger).toBeHidden();
});

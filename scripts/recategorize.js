// One-off: sorts the expenses that were all filed under "Groceries & Raw Material" into proper categories.
//   node scripts/recategorize.js            -> shows what would move (changes nothing)
//   node scripts/recategorize.js --apply    -> backs up data.json, then saves the changes
// Close the app first: it keeps its own copy in memory and would overwrite the file.
// With cloud sync on, the changed expenses are sent to the phone the next time the app opens.
const fs = require('fs'), path = require('path'), os = require('os');

const DIR = process.env.CANTEEN_DATA_DIR || path.join(os.homedir(), 'Documents', 'N.D. Patil Canteen Data');
const FILE = path.join(DIR, 'data.json');

const NEW_ORDER = [
  'Groceries & Raw Material', 'Vegetables', 'Meat and Fish', 'Chapati, Pav & Bhakri', 'Milk & Dairy',
  'Cold Drinks & Beverages', 'Gas / Fuel', 'Electricity', 'Water', 'Rent', 'Repairs & Maintenance',
  'Kitchen Utensils & Equipment', 'Packaging', 'Cleaning', 'License Renewal', 'Transport', 'Miscellaneous'
];
// first match wins; only expenses in the "from" categories are moved
const RULES = [
  { to: 'Kitchen Utensils & Equipment', re: /thermos|tawa|utensil|steel plate/, from: ['Groceries & Raw Material', 'Miscellaneous'] },
  { to: 'Packaging', re: /use and throw|paper dish|paper glass|cutlery/ },
  { to: 'Cleaning', re: /cleaning powder|washing powder|handwash/ },
  { to: 'Meat and Fish', re: /mutton|chicken|fish|surmai|rawas|bangda|prawn/ },
  { to: 'Chapati, Pav & Bhakri', re: /\bpav\b|chapati|bhakri|bhakari/ },
  { to: 'Milk & Dairy', re: /milk|chaas/ },
  { to: 'Cold Drinks & Beverages', re: /pepsi|oxycool|kokam|coffee|chai patti/ },
  { to: 'Vegetables', re: /bhaji|onion|potato|popato|poptato|garlic|lemon|coconut|mirchi|chil+i|ginger|vegetable/ }
];

const S = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const moves = [];
for (const e of S.expenses) {
  const d = (e.desc || '').toLowerCase();
  const r = RULES.find(r => (r.from || ['Groceries & Raw Material']).includes(e.category) && r.re.test(d));
  if (r && r.to !== e.category) moves.push({ e, from: e.category, to: r.to });
}
const by = {};
for (const m of moves) (by[m.to] = by[m.to] || []).push(m.e.desc);
for (const [to, list] of Object.entries(by)) console.log(`→ ${to} (${list.length}): ${list.join(' | ')}`);
const left = S.expenses.filter(e => e.category === 'Groceries & Raw Material' && !moves.some(m => m.e === e));
console.log(`\nStays in Groceries & Raw Material (${left.length}): ${left.map(e => e.desc).join(' | ')}`);
console.log(`\n${moves.length} of ${S.expenses.length} expenses would move.`);

if (process.argv.includes('--apply')) {
  const backup = path.join(DIR, `data-before-recategorize-${Date.now()}.json`);
  fs.copyFileSync(FILE, backup);
  for (const m of moves) m.e.category = m.to;
  const used = new Set(S.expenses.map(e => e.category));
  const extra = S.settings.categories.filter(c => !NEW_ORDER.includes(c));
  S.settings.categories = [...NEW_ORDER, ...extra].filter((c, i, a) => a.indexOf(c) === i && (NEW_ORDER.includes(c) || used.has(c) || extra.includes(c)));
  fs.writeFileSync(FILE, JSON.stringify(S));
  console.log(`\nSaved. Backup of the old file: ${backup}`);
}

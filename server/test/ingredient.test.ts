/**
 * Ingredient parsing, against lines taken verbatim from 58 saved NYT recipes.
 * Each case here is a shape that produced a store-search miss before parsing
 * existed: the queries are what the fix has to produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredient, normalize } from '../src/recipes/ingredient.js';

const q = (line: string): string[] => parseIngredient(line).queries;

test('a quantity and its unit are not part of the name', () => {
  assert.deepEqual(q('30 grams all-purpose flour'), ['all purpose flour']);
  assert.deepEqual(q('2 tablespoons vegetable oil'), ['vegetable oil']);
});

test('a quantity range is stripped whole', () => {
  assert.equal(q('1 1/4 to 1 3/4 kilograms boneless chuck roast')[0], 'boneless chuck roast');
  assert.equal(q('8 to 12 pepperoncini')[0], 'pepperoncini');
});

test('preparation after the comma is not the product', () => {
  assert.equal(q('2 large tomatoes, cored and finely chopped')[0], 'tomatoes');
  // "garlic cloves" is not a product; the ladder falls through to "garlic".
  assert.deepEqual(q('3 garlic cloves, finely chopped').slice(0, 2), ['garlic cloves', 'garlic']);
});

test('parentheses hold sizes and asides, never the name', () => {
  assert.equal(q('12 (15-centimeter) corn tortillas')[0], 'corn tortillas');
  assert.equal(q('1 (2-inch) piece ginger')[0], 'ginger');
  assert.equal(q('85 grams store-bought pita chips (see Tip)')[0], 'store bought pita chips');
});

test('"or" alternatives are split, and the head noun is distributed', () => {
  // "grapeseed" alone matches nothing; the oil is what is being bought.
  assert.deepEqual(q('2 tablespoons grapeseed or canola oil').slice(0, 2), [
    'grapeseed oil',
    'canola oil',
  ]);
  assert.deepEqual(q('1 medium poblano or green bell pepper, stemmed').slice(0, 2), [
    'poblano pepper',
    'green bell pepper',
  ]);
});

test('accents are stripped, because shelves spell it without them', () => {
  assert.equal(normalize('queso añejo'), 'queso anejo');
  assert.deepEqual(q('225 grams queso añejo or cotija, crumbled').slice(0, 2), [
    'queso anejo',
    'cotija',
  ]);
});

test('fraction glyphs do not survive into the query', () => {
  assert.equal(q('½ teaspoon dried dill')[0], 'dried dill');
  assert.equal(q('¼ cup all-purpose flour')[0], 'all purpose flour');
});

test('size adjectives describe the shopper, not the product', () => {
  assert.equal(q('2 medium-size sweet potatoes (aka yams)')[0], 'sweet potatoes');
  assert.equal(q('1 small red onion, thinly sliced')[0], 'red onion');
});

test('a recipe form word is relaxed away, since stores name the form differently', () => {
  // Sold as "Crushed Red Pepper" and "Thyme Leaves".
  assert.deepEqual(q('1 teaspoon red-pepper flakes'), ['red pepper flakes', 'red pepper']);
  assert.equal(q('5 thyme sprigs')[1], 'thyme');
  assert.deepEqual(q('2 celery stalks').slice(0, 2), ['celery stalks', 'celery']);
});

test('seasoning and garnish are excluded rather than mispriced', () => {
  for (const line of [
    'Kosher salt (such as Diamond Crystal) and black pepper',
    'Salt and pepper',
    'Warm water, as needed',
    'Ice',
    'Chopped parsley, for garnish',
    'Cooked rice, for serving',
  ]) {
    assert.equal(parseIngredient(line).pantry, true, line);
  }
});

test('a salted ingredient you actually buy is not mistaken for seasoning', () => {
  assert.equal(parseIngredient('225 grams salted butter').pantry, false);
  assert.equal(parseIngredient('2 teaspoons salted capers').pantry, false);
});

test('queries are ordered most specific first and never duplicated', () => {
  const queries = q('2 tablespoons extra-virgin olive oil');
  assert.equal(queries[0], 'extra virgin olive oil');
  assert.equal(new Set(queries).size, queries.length);
});

test('relaxation never drops a describing word', () => {
  // Each of these was matched to the wrong product when the ladder was allowed
  // to fall back to the head noun: canola oil, tomato paste, a soda, and
  // flat-leaf parsley respectively.
  for (const [line, banned] of [
    ['4 tablespoons extra-virgin olive oil', 'oil'],
    ['80 milliliters white miso paste', 'paste'],
    ['120 milliliters dry white wine', 'wine'],
    ['1 bay leaf', 'leaf'],
    ['1 teaspoon chile powder', 'powder'],
  ] as const) {
    assert.ok(!q(line).includes(banned), `${line} must not relax to "${banned}"`);
  }
});

test('preparation the cook performs is not on the label', () => {
  // The shelf says "Cilantro"; the recipe says how to cut it.
  assert.equal(q('25 grams roughly chopped fresh cilantro')[0], 'fresh cilantro');
  assert.equal(q('1 teaspoon minced fresh ginger')[0], 'fresh ginger');
  // Product states that do appear on labels survive.
  assert.equal(q('2 teaspoons ground cumin')[0], 'ground cumin');
  assert.equal(q('1 teaspoon dried oregano')[0], 'dried oregano');
});

test('a trailing qualifier is provenance, not product', () => {
  assert.equal(q('1 (425-gram) can diced tomatoes with their juices')[0], 'tomatoes');
});

test('two quantities of one ingredient still name that ingredient', () => {
  // Found by running the parser over all 58 recipes: cutting at "plus" left
  // "60 milliliters" and the line parsed to no queries at all.
  for (const line of [
    '60 milliliters plus 3 tablespoons extra-virgin olive oil, plus more',
    '2 teaspoons plus 2 tablespoons extra-virgin olive oil',
  ]) {
    assert.deepEqual(q(line), ['extra virgin olive oil'], line);
  }
});

test('a line that is not pantry always yields at least one query', () => {
  assert.ok(q('2 teaspoons plus 2 tablespoons extra-virgin olive oil').length > 0);
});

test('a container is a unit, not part of the name', () => {
  assert.equal(q('1 340-gram bag fresh or thawed frozen cranberries')[0], 'fresh cranberries');
});

test('a hyphenated prep word is filtered whole, not split first', () => {
  // Coverage run over the 58 recipes: converting the hyphen to a space before
  // filtering split "de-stemmed" into "de" and "stemmed", the PREP filter
  // caught only "stemmed", and the stray "de" survived as a one-word query
  // that substring-matches almost any product ("Del Monte", "Dean's").
  // Losing "kale leaves" to the comma-cut is a separate, accepted gap (see
  // below); what matters here is that the miss stays honest instead of
  // reporting a false match.
  assert.deepEqual(q('45 grams de-stemmed, torn curly kale leaves (from 2 leaves)'), []);
});

test('"style" names no product on its own', () => {
  // "Buffalo-style hot sauce" was missing Frank's RedHot because no product
  // is literally named "Buffalo-Style Hot Sauce" — the manner word "style"
  // isn't kept on the shelf, just folded into "Buffalo Wings Hot Sauce".
  assert.deepEqual(q('120 milliliters Buffalo-style hot sauce, such as Frank’s'), ['buffalo hot sauce']);
});

test('a plural head noun still finds a shelf listing kept singular', () => {
  // "chipotles in adobo" needs a jar labeled "Chipotle Peppers in Adobo
  // Sauce"; "corn cobs" needs "Corn-On-The-Cob". Stripping a trailing "s" is
  // pure number, not a describing word, so it is safe to try as a fallback.
  assert.deepEqual(q('1 to 2 chipotles in adobo, seeded and chopped (to taste)'), [
    'chipotles in adobo',
    'chipotle in adobo',
  ]);
  assert.deepEqual(q('2 corn cobs (kernels removed and reserved for risotto)'), ['corn cobs', 'corn cob']);
});

test('"chile" and "chili" are the same word, spelled two ways', () => {
  // Recipes write the Spanish spelling; both stores stock "Chili Powder" and
  // "Chili Crisp" under the Anglicized one.
  assert.deepEqual(q('1 teaspoon chile powder, plus more to taste'), ['chile powder', 'chili powder']);
  assert.deepEqual(q('1/4 teaspoon ancho chile powder, optional'), ['ancho chile powder', 'ancho chili powder']);
});

test('a closed compound the shelf spells as two words', () => {
  // Every "Corn Starch" product on the shelf is two words; the recipe's
  // "cornstarch" cannot substring-match across the missing space.
  assert.equal(q('45 grams cornstarch')[0], 'corn starch');
});

test('a trailing "plus" clause is a second quantity, not a second product', () => {
  // The leading-quantity loop already catches "2 teaspoons plus 2
  // tablespoons oil"; this is the same idea trailing the name instead,
  // interrupted by a parenthetical on each side.
  assert.deepEqual(q('2 teaspoons cornstarch (for the sauce) plus 30 grams (for the tofu)'), ['corn starch']);
});

test('"squeezed" is what the cook does, not a product word', () => {
  assert.equal(q('60 milliliters freshly squeezed lime juice (from about 2 limes), or to taste')[0], 'lime juice');
});

test('a size word can mask a unit word behind it', () => {
  // "Large pinch of kosher salt" has no leading digit, so stripQuantity stops
  // at "Large" without ever seeing "pinch" — a unit. Only stripping "Large"
  // exposes it, and only a second pass catches it: a one-shot strip left
  // "pinch of kosher salt", a query that will substring-match almost nothing
  // (no product is named "pinch").
  assert.deepEqual(q('Large pinch of kosher salt'), ['kosher salt']);
  assert.deepEqual(q('Big handful cilantro'), ['cilantro']);
});

test('a bare size word borrows the head noun from the other alternative', () => {
  // "1 large or 2 small cucumbers" is one cucumber purchase with a size
  // choice, not two different products — unlike "grapeseed or canola oil",
  // where "canola oil" already carries its own head noun.
  assert.deepEqual(q('1 large or 2 small cucumbers, peeled and thinly sliced').slice(0, 2), [
    'large cucumbers',
    'large cucumber',
  ]);
});

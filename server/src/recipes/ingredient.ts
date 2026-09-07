/**
 * Turns one NYT Cooking ingredient line into store-search queries.
 *
 * The lines are half-structured: a quantity is split out, but the unit is glued
 * to the front of the text, preparation follows a comma, sizes and asides sit
 * in parentheses, and alternatives are spelled with "or". Handing that text to
 * a store search verbatim finds nothing — "poblano or green bell pepper,
 * stemmed, seeded and chopped" is not a product name anywhere.
 *
 * Measured against 58 saved recipes (686 lines), the failures that mattered
 * were, in order: unsplit "or" alternatives, accented characters, retained
 * stopwords and size adjectives, and recipe-side form words ("sprigs",
 * "flakes") that stores spell differently ("Thyme Leaves", "Crushed Red
 * Pepper"). Each is handled below.
 *
 * `queries` is a ladder, most specific first. A caller should try them in
 * order and stop at the first hit.
 *
 * Relaxation only ever drops a *measurement* or *form* word — "garlic cloves"
 * to "garlic", "thyme sprigs" to "thyme". It never drops a describing word,
 * because that changes what is being bought: relaxing "extra-virgin olive oil"
 * to "oil" matched Food Lion Canola Oil, "white miso paste" to "paste" matched
 * Tomato Paste, and "bay leaf" to "leaf" matched flat-leaf parsley. Reach
 * bought that way is indistinguishable from a wrong answer, so the ladder
 * stops rather than guessing.
 *
 * Separately, the ladder also normalizes orthography that carries no product
 * information at all: a plural head noun where the shelf keeps the singular
 * ("corn cobs" / "Corn-On-The-Cob"), "chile" versus "chili", a closed
 * compound the shelf spells as two words ("cornstarch" / "Corn Starch"), and
 * a linking word like "style" that names no product on its own. None of
 * these change what is being bought, so none of them carry the same risk as
 * dropping a describing word.
 */

/** Fraction glyphs NYT uses in place of ASCII fractions. */
const FRACTIONS: Record<string, string> = {
  '¼': '1/4', '½': '1/2', '¾': '3/4', '⅐': '1/7', '⅑': '1/9', '⅒': '1/10',
  '⅓': '1/3', '⅔': '2/3', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

/**
 * Lines that are seasoning, garnish or an instruction rather than something
 * you buy for this recipe. They are not matcher failures and must not count
 * against coverage — pricing "Salt and pepper" would be inventing a number.
 */
const PANTRY =
  /^(?:kosher |sea |fine sea |flaky |coarse |table )?(?:salt|pepper|salt and pepper|salt and freshly ground pepper|black pepper|white pepper|water|warm water|cold water|boiling water|just-boiled water|ice|ice water|cooking spray|nonstick cooking spray)\b/;
const GARNISH = /\b(?:for (?:serving|garnish|topping|drizzling|frying|dusting|the pot|brushing)|to taste|as needed)\b/;

/** Measurement words, whether they lead the text or trail it. */
const UNITS = new Set([
  'gram', 'grams', 'kilogram', 'kilograms', 'kg', 'g',
  'milliliter', 'milliliters', 'liter', 'liters', 'ml', 'l',
  'teaspoon', 'teaspoons', 'tsp', 'tablespoon', 'tablespoons', 'tbsp',
  'cup', 'cups', 'pint', 'pints', 'quart', 'quarts', 'gallon', 'gallons',
  'pound', 'pounds', 'lb', 'lbs', 'ounce', 'ounces', 'oz',
  'can', 'cans', 'jar', 'jars', 'package', 'packages', 'packet', 'packets',
  'bag', 'bags', 'box', 'boxes', 'bottle', 'bottles', 'container', 'containers',
  'tub', 'tubs', 'carton', 'cartons', 'loaf', 'loaves', 'sheet', 'sheets',
  'bunch', 'bunches', 'head', 'heads', 'clove', 'cloves', 'stalk', 'stalks',
  'sprig', 'sprigs', 'slice', 'slices', 'piece', 'pieces', 'stick', 'sticks',
  'dash', 'dashes', 'pinch', 'pinches', 'handful', 'handfuls',
]);

/** Adjectives that describe the shopper's choice, not the product. */
const SIZES = new Set([
  'large', 'small', 'medium', 'medium-size', 'medium-sized', 'big', 'jumbo',
  'extra-large', 'baby', 'whole', 'half', 'ripe', 'firm', 'thin', 'thick',
]);

/**
 * Words a recipe uses for a form the store names differently: a recipe says
 * "thyme sprigs", the shelf says "Thyme Leaves"; "red-pepper flakes" is sold
 * as "Crushed Red Pepper". Dropping the trailing form word yields the looser
 * query that finds them.
 */
const FORMS = new Set([
  'flakes', 'sprigs', 'leaves', 'stalks', 'wedges', 'chunks', 'strips',
  'rounds', 'halves', 'cubes', 'florets', 'segments',
]);

/**
 * What the cook does to the ingredient, which is never on the label: a shelf
 * says "Cilantro", a recipe says "roughly chopped fresh cilantro". Product
 * states that *do* appear on labels — ground, dried, smoked, frozen, canned,
 * whole, extra-virgin — are deliberately absent from this list.
 */
const PREP = new Set([
  'minced', 'chopped', 'sliced', 'grated', 'crushed', 'diced', 'torn',
  'shredded', 'cooked', 'freshly', 'finely', 'thinly', 'roughly', 'coarsely',
  'peeled', 'seeded', 'stemmed', 'de-stemmed', 'trimmed', 'drained', 'rinsed',
  'softened', 'melted', 'packed', 'warmed', 'chilled', 'halved', 'quartered',
  'crumbled', 'cored', 'zested', 'juiced', 'washed', 'raw', 'squeezed',
]);

/** Leading words that carry no product meaning. */
const LEADING_NOISE = new Set(['about', 'approximately', 'roughly', 'a', 'an', 'the', 'of', 'plus', 'scant', 'generous', 'heaping']);

/**
 * Linking words in "X-style Y" constructions ("Buffalo-style hot sauce",
 * "Italian-style sausage"): they signal manner, not a distinct product, and
 * shelves fold the manner into the flavor name rather than keeping the word
 * itself ("Frank's RedHot Buffalo Wings Hot Sauce", never "Buffalo Style Hot
 * Sauce"). Unlike a describing word, dropping it loses no information about
 * what is being bought, so it is filtered unconditionally.
 */
const LINKING = new Set(['style']);

/** Strips accents, normalises quotes and fraction glyphs, collapses space. */
export function normalize(text: string): string {
  let out = text.replace(/<[^>]*>/g, ' ');
  out = out.replace(/[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (c) => ` ${FRACTIONS[c] ?? ''} `);
  // Accents are stripped rather than preserved: shelves spell it "Queso
  // Anejo", recipes spell it "queso añejo", and a search is a substring test.
  out = out.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
  out = out.replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"');
  out = out.replace(/[‐-―]/g, '-').replace(/ /g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** Removes a leading count/unit run: "2 1/4 to 3 kilograms", "12", "About 285 grams". */
function stripQuantity(text: string): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    const before = out;
    out = out.replace(/^(?:[\d.,]+(?:\s*\/\s*\d+)?)(?:\s*(?:-|to|or)\s*(?:[\d.,]+(?:\s*\/\s*\d+)?))?\s*/i, '');
    // "340-gram bag", "15-centimeter tortillas": the number is gone, and the
    // unit it was hyphenated to is left dangling.
    out = out.replace(/^-\s*[a-z]+\s*/i, '');
    const word = /^([a-z-]+)\s*/i.exec(out);
    if (word && (UNITS.has(word[1]!.toLowerCase()) || LEADING_NOISE.has(word[1]!.toLowerCase()))) {
      out = out.slice(word[0].length);
    }
    if (out !== before) changed = true;
  }
  return out.trim();
}

/** Drops leading size/quality adjectives once the quantity is gone. */
function stripSizes(text: string): string {
  const words = text.split(' ');
  let i = 0;
  while (i < words.length - 1 && SIZES.has(words[i]!.toLowerCase())) i++;
  return words.slice(i).join(' ');
}

/**
 * Alternates quantity- and size-stripping until neither finds anything left
 * to remove. A single pass of each is not enough: "Large pinch of kosher
 * salt" has no leading digit, so `stripQuantity` stops at "Large" without
 * ever seeing "pinch"; only once `stripSizes` removes "Large" does "pinch" —
 * a unit — become the leading word for a second `stripQuantity` pass to
 * catch, the same way "of" only becomes leading once "pinch" is gone.
 */
function stripLeading(text: string): string {
  let out = text;
  let changed = true;
  while (changed) {
    const before = out;
    out = stripSizes(stripQuantity(out));
    changed = out !== before;
  }
  return out;
}

/**
 * "grapeseed or canola oil" means two oils, but a naive split leaves
 * "grapeseed" — which matches nothing. The final alternative carries the head
 * noun, so it is distributed to any shorter alternative that lacks one.
 *
 * A bare size word ("1 large or 2 small cucumbers") is not a shorter version
 * of the same rule: it is what is left after stripping a leading quantity and
 * size from a leading alternative that never had its own noun, so the head is
 * distributed to it even when the final alternative is itself a single word
 * ("large" needs "cucumbers"; "salt" next to "pepper" does not).
 */
function distributeHead(parts: string[]): string[] {
  if (parts.length === 0) return parts;
  const last = parts[parts.length - 1]!.split(' ');
  const head = last[last.length - 1]!;
  const lastHasModifier = last.length > 1;
  return parts.map((part, i) => {
    if (i === parts.length - 1) return part;
    const words = part.split(' ');
    if (words.length !== 1) return part;
    const isBareSize = SIZES.has(words[0]!.toLowerCase());
    if (isBareSize || (lastHasModifier && words[0] !== head)) return `${part} ${head}`;
    return part;
  });
}

/**
 * Strips a likely plural "s" so a recipe's plural head noun still finds a
 * shelf listing kept in the singular: "chipotles in adobo" needs a jar
 * labeled "Chipotle Peppers in Adobo Sauce", "corn cobs" needs "Corn-On-The-
 * Cob". Skipped for words that are naturally singular despite ending in "s"
 * (asparagus, hummus, molasses) so this never turns a real word into a
 * fragment that happens to substring-match something unrelated.
 */
function singularize(word: string): string {
  if (word.length > 3 && /[a-z]s$/i.test(word) && !/(?:ss|us)$/i.test(word)) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * "chile" and "chili" are the same loanword, transliterated two ways.
 * Recipes lean Spanish ("chile powder", "chile crisp"), shelves lean
 * Anglicized ("Chili Powder", "Chili Crisp") — same product either way, so
 * both spellings are offered rather than the ladder stopping on an accident
 * of orthography.
 */
function chileVariant(text: string): string | null {
  if (/\bchile(s)?\b/i.test(text)) return text.replace(/\bchile(s)?\b/gi, 'chili$1');
  if (/\bchili(s)?\b/i.test(text)) return text.replace(/\bchili(s)?\b/gi, 'chile$1');
  return null;
}

export interface ParsedIngredient {
  raw: string;
  /** Seasoning, garnish or instruction: excluded from pricing, not a failure. */
  pantry: boolean;
  /** Store-search candidates, most specific first. Empty when `pantry`. */
  queries: string[];
}

export function parseIngredient(line: string): ParsedIngredient {
  const raw = line;
  let text = normalize(line);
  if (text === '') return { raw, pantry: true, queries: [] };
  // Recipes write the closed compound as one word; every shelf spells it as
  // two ("Corn Starch"), and a substring test cannot bridge a missing space.
  text = text.replace(/\bcornstarch\b/gi, 'corn starch');

  const hasQuantity = /^[\d.]/.test(text);
  const bare = stripQuantity(text).toLowerCase();
  if (PANTRY.test(bare) || (!hasQuantity && GARNISH.test(text.toLowerCase()))) {
    return { raw, pantry: true, queries: [] };
  }

  // Parentheses hold sizes ("(15-centimeter)"), brand asides ("(such as
  // Diamond Crystal)") and cross-references ("(see Tip)") — none are product
  // names. Preparation follows the first comma and is likewise not the name.
  text = text.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.split(',')[0]!;
  // A trailing qualifier describes provenance or a substitution, not the
  // product: "diced tomatoes with their juices", "noodles like linguine".
  // Not "plus": "60 milliliters plus 3 tablespoons olive oil" is one
  // ingredient measured twice, and the quantity loop above already eats it.
  text = text.split(/\s+(?:from|like|with|such as|depending on)\s+/i)[0]!;

  const alternatives = distributeHead(
    text
      .split(/\s+or\s+/i)
      .map((part) => {
        const stripped = stripLeading(part.trim());
        // A second, trailing quantity for the same ingredient ("cornstarch
        // (for the sauce) plus 30 grams (for the tofu)") is not a describing
        // word for a different product — the quantity loop above only
        // catches a *leading* repeat ("2 teaspoons plus 2 tablespoons oil");
        // this catches one that trails the name instead.
        return stripped.split(/\s+plus\s+/i)[0]!;
      })
      .filter((part) => part.length > 1),
  );

  const queries: string[] = [];
  const push = (q: string): void => {
    // A prep word is filtered as a whole hyphenated token first ("de-stemmed"
    // is one PREP entry) — converting hyphens to spaces before filtering
    // would split it into "de" and "stemmed", "stemmed" would be dropped, and
    // the stray "de" would survive as a one-off query that substring-matches
    // almost anything ("Del Monte", "Dean's"). Shelves do not hyphenate what
    // survives: "extra-virgin olive oil" is sold as "Extra Virgin Olive Oil",
    // so remaining hyphens become spaces only after that filter has run.
    const clean = q
      .replace(/[^a-z0-9'\- ]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w !== '' && !PREP.has(w.toLowerCase()))
      .map((w) => w.replace(/(?<=[a-z])-(?=[a-z])/gi, ' '))
      .join(' ')
      .split(/\s+/)
      .filter((w) => w !== '' && !PREP.has(w.toLowerCase()) && !LINKING.has(w.toLowerCase()))
      .join(' ')
      .trim()
      .toLowerCase();
    if (clean.length > 1 && !queries.includes(clean)) queries.push(clean);
  };

  for (const alt of alternatives) {
    push(alt);
    const chileAlt = chileVariant(alt);
    if (chileAlt) push(chileAlt);

    const words = alt.split(' ');
    const tail = words[words.length - 1]!.toLowerCase();
    if (words.length > 1 && (FORMS.has(tail) || UNITS.has(tail))) {
      // The same alternative without a trailing form or measurement word.
      // This is the looser query that finds "Thyme Leaves" for "thyme
      // sprigs" and "Garlic" for "garlic cloves" — a unit can trail the name
      // as well as lead it, and "3 garlic cloves" is three of the bulb, not
      // a product.
      const relaxed = words.slice(0, -1).join(' ');
      push(relaxed);
      const chileRelaxed = chileVariant(relaxed);
      if (chileRelaxed) push(chileRelaxed);
    } else {
      // Last resort: the shelf keeps the head noun singular where the
      // recipe pluralizes it ("chipotles in adobo" needs a jar labeled
      // "Chipotle Peppers", "corn cobs" needs "Corn-On-The-Cob"). Skipped
      // whenever the form/unit relaxation above already fired, so a plural
      // form word ("flakes") never gets a redundant singular rung too.
      const singular = words.map(singularize).join(' ');
      if (singular !== alt) push(singular);
    }
  }
  return { raw, pantry: false, queries };
}

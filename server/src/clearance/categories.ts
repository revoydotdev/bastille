/**
 * What the sweep asks Walmart for, and how a find is classified once it comes
 * back.
 *
 * The shelf ids here were taken from the live API, not from Walmart's browse
 * sitemap: the sitemap still lists chains such as `3944_3951_1073804` that the
 * Browse operation now rejects with `INVALID_CAT_ID`. Every id below has been
 * exercised against the real endpoint.
 */

export type CategoryGroup = 'pc-parts' | 'video-games' | 'electronics';

export interface ClearanceCategory {
  /** Walmart's category chain, sent verbatim as `catId`. */
  id: string;
  slug: string;
  label: string;
  group: CategoryGroup;
}

/**
 * Three shelves per store. Computers is a subset of Electronics, and Video Games
 * overlaps it, so sweeping them separately costs extra reads per store — and
 * buys the classification.
 *
 * Walmart reports a *different* `categoryPathId` for the same item depending on
 * which shelf you asked: a 32-inch monitor comes back under `0:3944:1089430:…`
 * on the Computers shelf and under `0:6163033:…` on the Electronics one. So the
 * path cannot be trusted to say what a thing is. Which shelf Walmart puts it on
 * can be, and that is what `group` records.
 */
export const CLEARANCE_CATEGORIES: ClearanceCategory[] = [
  { id: '3944', slug: 'electronics', label: 'Electronics', group: 'electronics' },
  { id: '3944_1089430', slug: 'computers', label: 'Computers', group: 'pc-parts' },
  { id: '2636', slug: 'video-games', label: 'Video games', group: 'video-games' },
];

/**
 * Which shelf wins when Walmart lists the same item on more than one. The
 * narrower shelf is the more informative: a gaming headset on both Video Games
 * and Electronics is better described by the former, and anything Walmart files
 * under Computers is a PC part whatever else it also appears under.
 */
const GROUP_PRECEDENCE: CategoryGroup[] = ['pc-parts', 'video-games', 'electronics'];

export function narrowerGroup(a: CategoryGroup, b: CategoryGroup): CategoryGroup {
  return GROUP_PRECEDENCE.indexOf(a) <= GROUP_PRECEDENCE.indexOf(b) ? a : b;
}

const BY_SLUG = new Map(CLEARANCE_CATEGORIES.map((c) => [c.slug, c]));

export function categoryBySlug(slug: string): ClearanceCategory | null {
  return BY_SLUG.get(slug) ?? null;
}

export const CATEGORY_GROUPS: { id: CategoryGroup; label: string }[] = [
  { id: 'pc-parts', label: 'PC parts & computers' },
  { id: 'video-games', label: 'Video games' },
  { id: 'electronics', label: 'Other electronics' },
];

export function isCategoryGroup(value: string): value is CategoryGroup {
  return (GROUP_PRECEDENCE as string[]).includes(value);
}

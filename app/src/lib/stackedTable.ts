/**
 * Primary tables (standings, roster) turn each row into a small card below `sm` (#138): the table
 * and its body become blocks, the header row is kept for screen readers only, and each row is a
 * grid its cells place themselves in. These are the pieces every such table shares.
 */

/** On the `<table>` and `<tbody>`. */
export const STACKED_BLOCK = 'max-sm:block';

/** On the `<thead>`: out of sight below `sm`, still read out. */
export const STACKED_HEAD = 'max-sm:sr-only';

/** On each `<tr>`, with its own `max-sm:grid-cols-[…]`. */
export const STACKED_ROW =
  'max-sm:grid max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1 max-sm:border-b max-sm:border-border max-sm:py-3';

/** On a cell that needs its column name once the header is out of sight: `data-label="PF"`. */
export const STACKED_LABEL =
  'max-sm:before:mr-1 max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]';

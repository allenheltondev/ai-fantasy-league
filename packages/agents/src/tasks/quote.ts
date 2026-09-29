/** Makes other people's text safe to quote: one line, no fence markers. */
export function quote(text: string, max = 400): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/<<<|>>>|```/g, "''")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

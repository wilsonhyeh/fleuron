function ellipsize(text: string, width: number) {
  return text.length > width ? `${text.slice(0, width - 1).trimEnd()}…` : text;
}

/**
 * Word-wrap for an SVG label, which has no wrapping of its own: at most
 * `maxLines` lines of about `width` characters, the last one ellipsed if
 * words are left over. The Structure view's centre used to cut the study
 * title at 16 characters on one line (a long title lost everything after its first two words).
 */
export function wrapLines(text: string, width: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (next.length <= width || !line) {
      line = next;
      continue;
    }
    if (lines.length === maxLines - 1) {
      lines.push(`${line} ${words.slice(i).join(" ")}`);
      line = "";
      break;
    }
    lines.push(line);
    line = words[i];
  }
  if (line) lines.push(line);
  return lines.map((l) => ellipsize(l, width));
}

// Display-only: the result no longer applies to the file, so tools must publish the untrimmed patch.
export function trimDiff(diff: string): string {
  const sections: string[][] = []
  for (const line of diff.split("\n")) {
    if (sections.length === 0 || line.startsWith("Index: ")) sections.push([])
    sections.at(-1)!.push(line)
  }
  return sections.flatMap(trimSection).join("\n")
}

function isContentLine(line: string) {
  return (
    (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
    !line.startsWith("---") &&
    !line.startsWith("+++")
  )
}

function trimSection(lines: string[]): string[] {
  let min = Infinity
  for (const line of lines) {
    if (!isContentLine(line)) continue
    const content = line.slice(1)
    if (content.trim().length > 0) min = Math.min(min, content.match(/^(\s*)/)![1].length)
  }
  if (min === Infinity || min === 0) return lines
  return lines.map((line) => (isContentLine(line) ? line[0] + line.slice(1).slice(min) : line))
}

interface AnsiSpan {
  text: string;
  className: string;
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: "text-[#1a1a1a] dark:text-[#c8c8c8]",
  31: "text-red-500",
  32: "text-emerald-500",
  33: "text-amber-500",
  34: "text-blue-500",
  35: "text-violet-500",
  36: "text-cyan-500",
  37: "text-foreground/80",
  90: "text-foreground/50",
  91: "text-red-400",
  92: "text-emerald-400",
  93: "text-amber-400",
  94: "text-blue-400",
  95: "text-violet-400",
  96: "text-cyan-400",
  97: "text-foreground/90",
};

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentClasses: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(input)) !== null) {
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index);
      if (text) spans.push({ text, className: currentClasses.join(" ") });
    }
    lastIndex = re.lastIndex;

    const codes = match[1].split(";").map(Number);
    for (const code of codes) {
      if (code === 0) {
        currentClasses = [];
      } else if (code === 1) {
        currentClasses = currentClasses.filter((c) => c !== "font-bold");
        currentClasses.push("font-bold");
      } else if (code === 2) {
        currentClasses = currentClasses.filter((c) => c !== "opacity-60");
        currentClasses.push("opacity-60");
      } else if (code === 3) {
        currentClasses = currentClasses.filter((c) => c !== "italic");
        currentClasses.push("italic");
      } else if (code === 4) {
        currentClasses = currentClasses.filter((c) => c !== "underline");
        currentClasses.push("underline");
      } else if (code === 39) {
        currentClasses = currentClasses.filter((c) => !c.startsWith("text-"));
      } else if (ANSI_COLOR_MAP[code]) {
        currentClasses = currentClasses.filter((c) => !c.startsWith("text-"));
        currentClasses.push(ANSI_COLOR_MAP[code]);
      }
    }
  }

  if (lastIndex < input.length) {
    spans.push({ text: input.slice(lastIndex), className: currentClasses.join(" ") });
  }

  if (spans.length === 0 && input.length > 0) {
    spans.push({ text: input, className: "" });
  }

  return spans;
}

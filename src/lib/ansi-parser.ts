import type React from "react";

interface AnsiSpan {
  text: string;
  className: string;
  style?: React.CSSProperties;
}

const ANSI_FG_MAP: Record<number, string> = {
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

const ANSI_FG_BRIGHT_MAP: Record<number, string> = {
  30: "text-foreground/50",
  31: "text-red-400",
  32: "text-emerald-400",
  33: "text-amber-400",
  34: "text-blue-400",
  35: "text-violet-400",
  36: "text-cyan-400",
  37: "text-foreground/90",
};

const ANSI_BG_MAP: Record<number, string> = {
  40: "bg-[#1a1a1a]",
  41: "bg-red-500",
  42: "bg-emerald-500",
  43: "bg-amber-500",
  44: "bg-blue-500",
  45: "bg-violet-500",
  46: "bg-cyan-500",
  47: "bg-foreground/80",
  100: "bg-foreground/50",
  101: "bg-red-400",
  102: "bg-emerald-400",
  103: "bg-amber-400",
  104: "bg-blue-400",
  105: "bg-violet-400",
  106: "bg-cyan-400",
  107: "bg-foreground/90",
};

const ANSI_256_COLORS: string[] = [
  "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

function get256Color(n: number): string {
  if (n < 16) return ANSI_256_COLORS[n];
  if (n >= 232) {
    const v = Math.round(((n - 232) * 255) / 23);
    return `rgb(${v},${v},${v})`;
  }
  const idx = n - 16;
  const r = Math.round(((Math.floor(idx / 36)) * 255) / 5);
  const g = Math.round(((Math.floor((idx % 36) / 6)) * 255) / 5);
  const b = Math.round(((idx % 6) * 255) / 5);
  return `rgb(${r},${g},${b})`;
}

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentClasses: string[] = [];
  let currentStyle: React.CSSProperties = {};
  let isBright = false;
  let match: RegExpExecArray | null;

  const pushSpan = (text: string) => {
    if (!text) return;
    const className = currentClasses.join(" ");
    const hasStyle = Object.keys(currentStyle).length > 0;
    spans.push({ text, className, ...(hasStyle ? { style: { ...currentStyle } } : {}) });
  };

  while ((match = re.exec(input)) !== null) {
    if (match.index > lastIndex) {
      pushSpan(input.slice(lastIndex, match.index));
    }
    lastIndex = re.lastIndex;

    const parts = match[1].split(";").map(Number);
    let i = 0;
    while (i < parts.length) {
      const code = parts[i];
      if (code === 0) {
        currentClasses = [];
        currentStyle = {};
        isBright = false;
      } else if (code === 1) {
        isBright = true;
        currentClasses = currentClasses.filter((c) => c !== "font-bold");
        currentClasses.push("font-bold");
        const fgClass = currentClasses.find((c) => c.startsWith("text-"));
        if (fgClass) {
          const fgCode = Object.entries(ANSI_FG_MAP).find(([, v]) => v === fgClass)?.[0];
          if (fgCode) {
            const bright = ANSI_FG_BRIGHT_MAP[Number(fgCode)];
            if (bright) {
              currentClasses = currentClasses.filter((c) => !c.startsWith("text-"));
              currentClasses.push(bright);
            }
          }
        }
      } else if (code === 2) {
        currentClasses = currentClasses.filter((c) => c !== "opacity-60");
        currentClasses.push("opacity-60");
      } else if (code === 3) {
        currentClasses = currentClasses.filter((c) => c !== "italic");
        currentClasses.push("italic");
      } else if (code === 4) {
        currentClasses = currentClasses.filter((c) => c !== "underline" && c !== "line-through");
        currentClasses.push("underline");
      } else if (code === 9) {
        currentClasses = currentClasses.filter((c) => c !== "underline" && c !== "line-through");
        currentClasses.push("line-through");
      } else if (code === 22) {
        isBright = false;
        currentClasses = currentClasses.filter((c) => c !== "font-bold" && c !== "opacity-60");
      } else if (code === 38 && parts[i + 1] === 5 && i + 2 < parts.length) {
        const color = get256Color(parts[i + 2]);
        currentClasses = currentClasses.filter((c) => !c.startsWith("text-"));
        currentStyle = { ...currentStyle, color };
        i += 2;
      } else if (code === 38 && parts[i + 1] === 2 && i + 4 < parts.length) {
        const color = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
        currentClasses = currentClasses.filter((c) => !c.startsWith("text-"));
        currentStyle = { ...currentStyle, color };
        i += 4;
      } else if (code === 39) {
        currentClasses = currentClasses.filter((c) => !c.startsWith("text-"));
        const { color: _color, ...rest } = currentStyle as { color?: string } & React.CSSProperties;
        currentStyle = rest;
      } else if (code === 48 && parts[i + 1] === 5 && i + 2 < parts.length) {
        const backgroundColor = get256Color(parts[i + 2]);
        currentClasses = currentClasses.filter((c) => !c.startsWith("bg-"));
        currentStyle = { ...currentStyle, backgroundColor };
        i += 2;
      } else if (code === 48 && parts[i + 1] === 2 && i + 4 < parts.length) {
        const backgroundColor = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
        currentClasses = currentClasses.filter((c) => !c.startsWith("bg-"));
        currentStyle = { ...currentStyle, backgroundColor };
        i += 4;
      } else if (code === 49) {
        currentClasses = currentClasses.filter((c) => !c.startsWith("bg-"));
        const { backgroundColor: _bg, ...rest } = currentStyle as { backgroundColor?: string } & React.CSSProperties;
        currentStyle = rest;
      } else if (ANSI_BG_MAP[code]) {
        currentClasses = currentClasses.filter((c) => !c.startsWith("bg-"));
        currentClasses.push(ANSI_BG_MAP[code]);
      } else if (ANSI_FG_MAP[code]) {
        currentClasses = currentClasses.filter((c) => !c.startsWith("text-"));
        const { color: _color, ...rest } = currentStyle as { color?: string } & React.CSSProperties;
        currentStyle = rest;
        const mapped = isBright && ANSI_FG_BRIGHT_MAP[code] ? ANSI_FG_BRIGHT_MAP[code] : ANSI_FG_MAP[code];
        currentClasses.push(mapped);
      }
      i++;
    }
  }

  if (lastIndex < input.length) {
    pushSpan(input.slice(lastIndex));
  }

  if (spans.length === 0 && input.length > 0) {
    spans.push({ text: input, className: "" });
  }

  return spans;
}

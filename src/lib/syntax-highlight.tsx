import { type CSSProperties, type ReactNode } from "react";
import { refractor } from "refractor/all";
import type { Root, Element, Text, ElementContent, RootContent } from "hast";

type PrismThemeStyle = Record<string, CSSProperties>;

// ── Style resolution ──
// Replicates react-syntax-highlighter's createStyleObject logic locally.
// Avoids fragile deep import into an untyped internal module path.

/**
 * Generates power-set permutations of class names (matching r-s-h's algorithm).
 * Prism tokens rarely exceed 2–3 non-token class names, so this covers all
 * realistic cases while keeping the logic simple.
 */
function getCombinations(names: string[]): string[] {
  if (names.length === 0) return [];
  if (names.length === 1) return names;

  const result: string[] = [...names];
  // 2-element permutations
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i !== j) result.push(`${names[i]}.${names[j]}`);
    }
  }
  // 3-element permutations
  if (names.length >= 3) {
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        for (let k = 0; k < names.length; k++) {
          if (i !== j && j !== k && i !== k) {
            result.push(`${names[i]}.${names[j]}.${names[k]}`);
          }
        }
      }
    }
  }
  return result;
}

/** Resolves inline styles for a Prism token by looking up its class names in the theme. */
function resolveTokenStyle(
  classNames: string[],
  stylesheet: PrismThemeStyle,
): CSSProperties {
  const names = classNames.filter((c) => c !== "token");
  const combos = getCombinations(names);
  let style: CSSProperties = {};
  for (const combo of combos) {
    if (stylesheet[combo]) style = { ...style, ...stylesheet[combo] };
  }
  return style;
}

// ── Full-file tokenization ──

/**
 * Tokenizes full content with file-level context using refractor (Prism),
 * then splits into per-line ReactNodes.
 *
 * This preserves multi-line construct highlighting (block comments, template
 * literals, multi-line strings) which is lost when highlighting individual lines.
 */
export function highlightToLines(
  code: string,
  language: string,
  style: PrismThemeStyle,
): ReactNode[] {
  if (!code) return [];
  if (language === "text" || !refractor.registered(language)) {
    return code.split("\n").map((line) => line || " ");
  }

  // Trim trailing newline to avoid a phantom empty line at the end
  const trimmed = code.endsWith("\n") ? code.slice(0, -1) : code;
  const tree: Root = refractor.highlight(trimmed, language);

  const lines: ReactNode[][] = [[]];
  let keyCounter = 0;

  function walk(
    node: RootContent | ElementContent,
    inheritedStyle: CSSProperties | undefined,
  ): void {
    if (node.type === "text") {
      const parts = (node as Text).value.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push([]);
        if (parts[i]) {
          if (inheritedStyle && Object.keys(inheritedStyle).length > 0) {
            lines[lines.length - 1].push(
              <span key={keyCounter++} style={inheritedStyle}>
                {parts[i]}
              </span>,
            );
          } else {
            lines[lines.length - 1].push(parts[i]);
          }
        }
      }
      return;
    }

    if (node.type === "element") {
      const el = node as Element;
      const classNames = (el.properties?.className as string[]) ?? [];
      // Merge parent styles with this element's token styles
      const tokenStyle = resolveTokenStyle(classNames, style);
      const mergedStyle = inheritedStyle
        ? { ...inheritedStyle, ...tokenStyle }
        : Object.keys(tokenStyle).length > 0
          ? tokenStyle
          : undefined;

      for (const child of el.children) {
        walk(child, mergedStyle);
      }
    }
  }

  for (const node of tree.children) {
    walk(node, undefined);
  }

  // Ensure empty lines render as non-collapsing whitespace
  return lines.map((tokens, i) =>
    tokens.length === 0
      ? " "
      : tokens.length === 1
        ? tokens[0]
        : <span key={`line-${i}`}>{tokens}</span>,
  );
}

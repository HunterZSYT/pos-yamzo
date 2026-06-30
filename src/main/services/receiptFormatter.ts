const PAPER_COLUMNS = 48;
const RECEIPT_WIDTH = 36;
const RECEIPT_INDENT = " ".repeat(Math.floor((PAPER_COLUMNS - RECEIPT_WIDTH) / 2));

export function receiptSeparator(char = "-"): string {
  return `${RECEIPT_INDENT}${char.repeat(RECEIPT_WIDTH)}`;
}

export function receiptTextLine(value: string): string {
  return value.trim() ? `${RECEIPT_INDENT}${value.trim()}` : "";
}

export function centerReceiptText(value: string): string {
  const text = value.trim();
  if (text.length >= RECEIPT_WIDTH) {
    return `${RECEIPT_INDENT}${text}`;
  }
  const leftPadding = Math.floor((RECEIPT_WIDTH - text.length) / 2);
  return `${RECEIPT_INDENT}${" ".repeat(leftPadding)}${text}`;
}

export function leftRightReceiptLine(left: string, right: string): string {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();
  const gap = RECEIPT_WIDTH - cleanLeft.length - cleanRight.length;
  if (gap <= 1) {
    return `${RECEIPT_INDENT}${cleanLeft}\n${RECEIPT_INDENT}${cleanRight.padStart(RECEIPT_WIDTH)}`;
  }
  return `${RECEIPT_INDENT}${cleanLeft}${" ".repeat(gap)}${cleanRight}`;
}

export function wrapReceiptText(value: string, width = RECEIPT_WIDTH): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return (lines.length ? lines : [""]).map((line) => (line ? `${RECEIPT_INDENT}${line}` : line));
}

export function formatTk(amount: number): string {
  return `${Math.round(amount)} TK`;
}

export function formatReceiptDateTime(date = new Date()): { date: string; time: string } {
  return {
    date: date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }),
    time: date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  };
}

export function formatSourceLabel(value: string): string {
  if (value === "in_house") {
    return "Dine-in";
  }
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

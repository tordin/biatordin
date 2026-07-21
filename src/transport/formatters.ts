export function cleanMarkdownForWhatsApp(text: string): string {
  if (!text) return "";

  // 1. Replace markdown links [Text](URL) with Text (URL)
  let processed = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");

  const lines = processed.split("\n");
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 2. Remove horizontal rules (e.g. ---, ***, ___)
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      if (resultLines.length > 0 && resultLines[resultLines.length - 1] !== "") {
        resultLines.push("");
      }
      continue;
    }

    // 3. Convert headers (e.g. ### Header) to bold (*Header*)
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const headerText = headerMatch[2];
      resultLines.push(`*${headerText}*`);
      continue;
    }

    // 4. Handle table rows
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed.split("|").slice(1, -1).map(c => c.trim());
      
      // Check if separator
      const isSeparator = cells.every(c => /^[:-]+$/.test(c));
      if (isSeparator) {
        continue;
      }

      // Check if the next line is a separator (which makes this row a table header)
      const nextLine = lines[i + 1] ? lines[i + 1].trim() : "";
      const isHeader = nextLine.startsWith("|") && nextLine.endsWith("|") && 
                       nextLine.split("|").slice(1, -1).map(c => c.trim()).every(c => /^[:-]+$/.test(c));
      if (isHeader) {
        continue;
      }

      if (cells.length === 2) {
        let key = cells[0].replace(/\*\*|__/g, "").trim();
        const val = cells[1];
        
        // Skip header lines
        if (key.toLowerCase() === "detalhe" && val.toLowerCase() === "informação") {
          continue;
        }
        if (key.toLowerCase() === "campo" && val.toLowerCase() === "valor") {
          continue;
        }
        if (key.toLowerCase() === "tabela" || key.toLowerCase() === "coluna") {
          continue;
        }

        resultLines.push(`*${key}*: ${val}`);
      } else if (cells.length > 0) {
        resultLines.push(cells.join(" - "));
      }
      continue;
    }

    // 5. Replace leading '*' bullet list marker with '•' to prevent weird bolding in WhatsApp
    const bulletMatch = line.match(/^(\s*)\*\s+(.+)$/);
    if (bulletMatch) {
      const indentation = bulletMatch[1];
      const content = bulletMatch[2];
      resultLines.push(`${indentation}• ${content}`);
      continue;
    }

    resultLines.push(line);
  }

  let finalResult = resultLines.join("\n");
  finalResult = finalResult.replace(/\n{3,}/g, "\n\n");
  
  return finalResult.trim();
}

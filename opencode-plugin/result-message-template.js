function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function renderResultMessageTemplate(input) {
  const omitHeader = input?.omitHeader === true;
  const headerTitle = String(input?.headerTitle ?? "").trim();
  const environmentNotice = String(input?.environmentNotice ?? "").trim();

  const metadataLines = Array.isArray(input?.metadataLines)
    ? input.metadataLines
        .filter((line) => typeof line === "string" && line.trim())
        .map((line) => `🔹 ${line.trim()}`)
        .join("\n")
    : "";

  const body = String(input?.body ?? "").trim();
  const includeRawBlock = input?.includeRawBlock === true;
  const rawText = String(input?.rawText ?? "");
  const mentionUserId = String(input?.mentionUserId ?? "").trim();
  const maxChars = Number.isFinite(input?.maxChars) ? input.maxChars : 1900;

  const buildSections = (sections) => sections.filter(Boolean).join("\n\n");

  let content = buildSections([
    !omitHeader && headerTitle ? `📋 **${headerTitle}**` : null,
    !omitHeader && environmentNotice ? `> ⚙️ **환경**: ${environmentNotice}` : null,
    metadataLines || null,
    body || null,
    // 원본 데이터가 잘리더라도 코드 블록이 닫히도록 구성
    includeRawBlock ? `📦 **원본 데이터**\n\`\`\`text\n${truncateText(rawText || "(비어 있음)", 700)}\n\`\`\`` : null
  ]);

  if (mentionUserId) {
    content = `🔔 <@${mentionUserId}>\n\n${content}`;
  }

  // 전체 컨텐츠 길이 제한 적용
  return truncateText(content, maxChars);
}
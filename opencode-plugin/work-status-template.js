function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeSingleLine(value, maxChars = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return truncateText(text, maxChars);
}

export function renderWorkStatusTemplate(input) {
  const phase = String(input?.phase ?? "in_progress");
  const promptPreview = normalizeSingleLine(input?.promptPreview, 160);
  const subtaskSummary = normalizeSingleLine(input?.subtaskSummary, 160);
  const detail = normalizeSingleLine(input?.detail, 180);
  const startedAtLabel = normalizeSingleLine(input?.startedAtLabel, 80);
  const elapsedLabel = normalizeSingleLine(input?.elapsedLabel, 80);

  const buildLines = (lines) => lines.filter((line) => line !== null).join("\n");

  if (phase === "waiting_user") {
    return buildLines([
      "🟠 **사용자 응답 대기 중**",
      "> 상태: 선택, 토큰 입력 또는 승인이 필요합니다.",
      "",
      `🔹 **진행 중인 작업**: ${subtaskSummary || "없음"}`,
      detail ? `📝 **상세 내용**: ${detail}` : null
    ]);
  }

  if (phase === "failed") {
    return buildLines([
      "❌ **처리 실패**",
      "",
      `🔹 **수행한 작업**: ${subtaskSummary || "없음"}`,
      elapsedLabel ? `⏱️ **소요 시간**: ${elapsedLabel}` : null,
      detail ? `📝 **실패 원인**: ${detail}` : null
    ]);
  }

  if (phase === "completed" || phase === "cancelled") {
    const isCompleted = phase === "completed";
    return buildLines([
      isCompleted ? "✅ **처리 완료**" : "🛑 **처리 중단 (취소됨)**",
      "",
      `🔹 **수행한 작업**: ${subtaskSummary || "없음"}`,
      elapsedLabel ? `⏱️ **소요 시간**: ${elapsedLabel}` : null,
      detail ? `📝 **비고**: ${detail}` : null
    ]);
  }

  return buildLines([
    "🔄 **작업 수행 중...**",
    promptPreview ? `> ${promptPreview}` : "> (프롬프트 수집 중...)",
    "",
    `🔹 **현재 작업**: ${subtaskSummary || "진행 중인 하위 작업 없음"}`,
    startedAtLabel ? `🕒 **시작 시각**: ${startedAtLabel}` : null
  ]);
}

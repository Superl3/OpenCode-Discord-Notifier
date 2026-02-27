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
  const startedAtLabel = normalizeSingleLine(input?.startedAtLabel, 80);
  const elapsedLabel = normalizeSingleLine(input?.elapsedLabel, 80);
  const resultPreview = normalizeSingleLine(input?.resultPreview, 320);
  const detail = normalizeSingleLine(input?.detail, 220);

  const buildLines = (lines) => lines.filter((line) => line !== null).join("\n");

  const normalizedPhase = phase === "started" ? "in_progress" : phase;

  const resolveStatusLabel = (value) => {
    const statusMap = {
      completed: "✅ **처리 완료**",
      failed: "❌ **처리 실패**",
      cancelled: "🛑 **처리 중단 (취소됨)**",
      waiting_user: "🟠 **사용자 응답 대기 중**",
    };
    return statusMap[value] || "🔄 **작업 수행 중...**";
  };

  const buildProcessInfoLine = () => {
    const statusLabel = resolveStatusLabel(normalizedPhase);
    const timeInfo = [];
    
    if (startedAtLabel) timeInfo.push(`🕒 ${startedAtLabel}`);
    if (elapsedLabel) timeInfo.push(`⏱️ ${elapsedLabel}`);

    if (timeInfo.length > 0) {
      return `${statusLabel} \`[ ${timeInfo.join(" | ")} ]\``;
    }
    return statusLabel;
  };

  const resolveResultText = () => {
    if (normalizedPhase === "completed") return resultPreview || "결과 내용을 수집하지 못했습니다.";
    if (normalizedPhase === "failed") return resultPreview || (detail ? `실패 원인: ${detail}` : "실패 원인을 수집하지 못했습니다.");
    if (normalizedPhase === "cancelled") return detail ? `취소 사유: ${detail}` : "사용자 취소로 종료되었습니다.";
    if (normalizedPhase === "waiting_user") return detail ? `사용자 입력 대기: ${detail}` : "선택, 토큰 입력 또는 승인을 기다리는 중입니다.";
    return "결과 생성 중...";
  };

  return buildLines([
    buildProcessInfoLine(),
    "",
    "🗣️ **사용자 프롬프트**",
    promptPreview ? `> ${promptPreview}` : "> *(프롬프트 수집 중...)*",
    "",
    "📄 **상태 및 결과**",
    `> ${resolveResultText()}`
  ]);
}
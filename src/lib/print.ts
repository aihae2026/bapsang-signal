// 인쇄 — 버튼을 눌러도 아무 일이 안 일어나는 자리를 알아냅니다.
//
// 인쇄가 안 된다는 이야기가 나왔습니다. 원인은 코드가 아니라 **창**이었습니다. 앱 안에 붙은
// 미리보기 패널이나 웹뷰처럼 다른 문서 안에 끼워진 창에서는 브라우저가 인쇄 대화상자를
// 막습니다. 오류도 안 나고 조용히 무시합니다 — 누른 사람에게는 버튼이 고장 난 것으로
// 보입니다.
//
// 막힌 것을 뚫을 방법은 없습니다. 할 수 있는 일은 **왜 안 열리는지 알려주고 나갈 길을
// 드리는 것**뿐입니다. 조용히 아무 일도 안 일어나는 것만은 없어야 합니다.

/** 이 창이 다른 문서 안에 끼워져 있으면 true. */
export function isEmbeddedWindow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // 바깥 창을 읽지도 못한다면 출처가 다른 프레임 안 — 역시 끼워져 있는 것입니다.
    return true;
  }
}

/**
 * 인쇄합니다. 막힌 자리면 인쇄하지 않고 onBlocked 를 부릅니다.
 *
 * 부르는 쪽이 안내 방식을 정합니다 — 연계 의뢰서는 주소까지 띄운 안내 상자를, 목록 화면은
 * 짧은 토스트를 씁니다.
 */
export function printPage(onBlocked: () => void): void {
  if (isEmbeddedWindow()) {
    onBlocked();
    return;
  }
  window.print();
}

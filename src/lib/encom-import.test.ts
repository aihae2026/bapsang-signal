// 엑셀 자료 읽기(parseEncomFiles) — 회귀 테스트
//
// 자료 줄이 어디서 시작하는지를 두고 사고가 날 뻔했습니다.
//
// 엔컴 「기간별 입금현황」은 머리글이 **두 줄**입니다. 윗줄에 「입금액」, 아랫줄에 「현금」·
// 「카드」가 옵니다. 그래서 자료는 머리글 두 줄 아래에서 시작합니다.
//
// 그런데 엔컴을 쓰지 않는 기관을 위해 배포하는 **빈 입력 양식**(자료 관리 화면 ③)은 머리글이
// 한 줄입니다. 「머리글 + 2」로 고정해 두면 양식의 첫 자료 줄이 **아무 말 없이 버려집니다**.
// 예시 줄을 지우고 2행부터 적으신 분은 그 한 분이 통째로 사라지고, 화면에는 아무 경고도
// 뜨지 않습니다.
//
// 그래서 「머리글 + 1」부터 읽고, 날짜·회원번호가 없는 줄은 원래 있던 검사가 걸러냅니다.
// 엔컴의 아랫줄 머리글(현금·카드)에는 날짜가 없으므로 그 줄은 그대로 넘어갑니다.

import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { parseEncomFiles } from "./encom-import";

function toFile(rows: unknown[][], name: string): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], name);
}

describe("자료 줄이 어디서 시작하든 읽힙니다", () => {
  test("엔컴 「기간별 입금현황」 — 머리글 두 줄", async () => {
    const parsed = await parseEncomFiles([
      toFile(
        [
          ["기간별 입금현황", "", "", "", ""],
          ["순번", "처리일자", "이용자명", "이용자번호", "입금액", ""],
          ["", "", "", "", "현금", "카드"],
          [1, "2026-09-01", "홍길동", "2026-00001", "3500", ""],
          [2, "2026-09-02", "홍길동", "2026-00001", "3500", ""],
        ],
        "엔컴.xlsx",
      ),
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.residents).toHaveLength(1);
    expect(parsed.attendance).toHaveLength(2);
    expect(parsed.residents[0].meal_tier).toBe("일반");
  });

  test("빈 입력 양식 — 예시 줄을 그대로 두고 3행부터 적은 경우", async () => {
    const parsed = await parseEncomFiles([
      toFile(
        [
          ["순번", "처리일자", "이용자명", "이용자번호", "개강일자", "프로그램명"],
          ["예시", "2026-01-02", "홍○동", "2026-0000", "2026-01-02", "경로식당 (dr-tech)"],
          [1, "2026-09-01", "홍길동", "2026-00001", "", "경로식당"],
        ],
        "양식.xlsx",
      ),
    ]);
    expect(parsed.errors).toEqual([]);
    // 예시 줄을 그냥 두고 올리셔도 홍○동(2026-0000)은 명부에 들어가지 않습니다.
    expect(parsed.residents.map((r) => r.id)).toEqual(["2026-00001"]);
  });

  test("★ 예시 줄을 지우고 2행부터 적어도 한 분도 사라지지 않습니다", async () => {
    const parsed = await parseEncomFiles([
      toFile(
        [
          ["순번", "처리일자", "이용자명", "이용자번호", "개강일자", "프로그램명"],
          [1, "2026-09-01", "홍길동", "2026-00001", "", "경로식당"],
          [2, "2026-09-01", "전우치", "2026-00002", "", "경로식당"],
        ],
        "양식.xlsx",
      ),
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.residents.map((r) => r.id).sort()).toEqual(["2026-00001", "2026-00002"]);
    expect(parsed.attendance).toHaveLength(2);
  });

  test("이름은 올리는 자리에서 가려집니다", async () => {
    const parsed = await parseEncomFiles([
      toFile(
        [
          ["순번", "처리일자", "이용자명", "이용자번호"],
          [1, "2026-09-01", "홍길녀", "2026-00001"],
        ],
        "양식.xlsx",
      ),
    ]);
    expect(parsed.residents[0].name).toBe("홍○녀");
  });
});

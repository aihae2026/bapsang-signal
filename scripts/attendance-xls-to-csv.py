# -*- coding: utf-8 -*-
"""앤컴 「기간별 입금현황」 .xls 를 residents / attendance CSV로 바꿉니다.

왜 CSV인가: 어르신 396명 × 운영일 130일이면 attendance가 4만 행이 넘습니다. SQL INSERT문으로
만들면 파일이 수 MB가 되어 Supabase SQL 편집기에 붙여넣을 수가 없습니다. Table Editor의
CSV 가져오기를 쓰는 것이 유일하게 현실적인 길입니다.

⚠️ 결과 파일에는 어르신 396명의 실명과 이용자번호가 들어갑니다. 저장소 안에 두지 마세요.
   이 스크립트는 결과를 저장소 밖(임시 폴더)에만 씁니다.

읽어낸 사실(2026년 1~8월 자료 기준):
  · 유효기록 13,299건 / 머리말·바닥글 889행은 걸러냄
  · 2026-01-02 ~ 03-13 은 **금요일만** 기록 → 리모델링 휴관 중 도시락 주 1회 배부
  · 2026-03-16(월) 재개관 후 평일 전부 운영
  · 재개관 후 기록이 없는 평일 6일은 전부 공휴일과 일치
"""
import sys, io, csv, collections, datetime, os

import xlrd

# 운영일은 자료에서 도출합니다 — 그날 오신 분이 한 명이라도 있으면 문을 연 날입니다.
#
# 처음에는 휴관 기간(2026-01-02~03-13은 금요일만)을 코드에 적어두었는데, 그 조건이 2025년
# 자료까지 걸려서 2025년의 평일 기록을 통째로 버렸습니다(217일 중 대부분). 날짜를 손으로
# 적어두면 자료가 늘어날 때마다 이렇게 어긋납니다.
#
# 운영 방식이 달랐던 시기(휴관 중 도시락 주 1회)를 가려내는 일은 앱이 합니다 — 앞뒤 2주
# 안에 운영일이 8일이 안 되면 평소와 다른 방식으로 본다는 규칙이라, 어느 해든 그대로
# 적용됩니다(src/lib/attendance-engine.ts 의 setOperatingDays).


def mask(name):
    """이름 가운데를 가립니다. 홍길동 → 홍○동

    가린 이름을 **저장까지** 합니다. 화면에서만 가리고 데이터베이스에 실명을 두면, 자료가
    한 번 새는 순간 어르신 396명의 실명이 그대로 나갑니다. 직원은 회원번호(2019-00000)로
    앤컴에서 바로 확인할 수 있으니 업무상 잃는 것이 없습니다.

    실명이 꼭 필요해지면 이 함수가 name을 그대로 돌려주게 하고 다시 가져오면 됩니다.
    """
    # 앤컴은 동명이인을 이름 뒤 숫자로 구분합니다("방숙자9"). 이름이 아니라 시스템이 붙인
    # 꼬리표이므로 떼어냅니다 — 안 그러면 마지막 글자를 남기는 규칙 탓에 숫자만 남습니다.
    name = name.rstrip("0123456789").strip()
    if len(name) <= 1:
        return name
    if len(name) == 2:
        return name[0] + "○"
    return name[0] + "○" * (len(name) - 2) + name[-1]


def find_columns(sheet):
    """머리글 줄을 찾아 열 위치를 알아냅니다.

    파일마다 열 구성이 다릅니다 — 1~4월분은 14열에 머리글이 3번째 줄, 5월 이후는 16열에
    4번째 줄입니다. 열 번호를 고정해 두면 어느 한쪽이 조용히 어긋나 엉뚱한 칸을 읽습니다.
    그래서 '순번'이 있는 줄을 찾아 이름으로 맞춥니다.

    입금액은 머리글이 두 줄에 걸쳐 있습니다(위 '입금액', 아래 '현금'·'카드'). 아래 줄에서
    찾습니다.
    """
    header_row = None
    for r in range(min(10, sheet.nrows)):
        row = [str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)]
        if "순번" in row and "처리일자" in row:
            header_row = (r, row)
            break
    if header_row is None:
        raise SystemExit(f"머리글 줄을 찾지 못했습니다: {sheet.name}")

    r, row = header_row
    sub = [str(sheet.cell_value(r + 1, c)).strip() for c in range(sheet.ncols)]
    idx = {}
    for c, v in enumerate(row):
        if v in ("처리일자", "이용자명", "이용자번호", "적요"):
            idx.setdefault(v, c)
    cash = next((c for c, v in enumerate(sub) if v == "현금"), None)
    card = next((c for c, v in enumerate(sub) if v == "카드"), None)
    for need in ("처리일자", "이용자명", "이용자번호"):
        if need not in idx:
            raise SystemExit(f"'{need}' 열을 찾지 못했습니다: {sheet.name}")
    return r, idx, cash, card


def read_rows(paths):
    """여러 파일에서 (날짜, 이름, 이용자번호, 금액칸) 을 모읍니다.

    금액을 함께 읽는 이유: 3,500원은 일반, 1,800원은 감면, 빈칸은 무료급식입니다. 무료
    이용자가 자료에 들어 있는지 확인해야 합니다 — 빠져 있으면 가장 취약한 분들이 화면에서
    통째로 안 보이게 되고, 그 사실을 모른 채 "우리 기관 전체를 보고 있다"고 믿게 됩니다.
    """
    out, skipped = [], 0
    for path in paths:
        sheet = xlrd.open_workbook(path).sheet_by_index(0)
        hr, idx, cash, card = find_columns(sheet)
        for r in range(hr + 2, sheet.nrows):
            v = [str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)]
            date = v[idx["처리일자"]]
            name = v[idx["이용자명"]]
            member = v[idx["이용자번호"]]
            # 보고서 출력물이라 33행마다 바닥글("2026-08-29 오후 1:43:04  -1-")과 머리글이
            # 되풀이됩니다. 날짜 모양이 아닌 줄은 자료가 아닙니다.
            if len(date) != 10 or date[4] != "-" or not member:
                skipped += 1
                continue
            # 금액 표기가 파일마다 다릅니다 — 2025년분은 "3,500"(글자), 2026년분은 3500.0(숫자).
            # 그대로 두면 같은 3,500원이 두 종류로 세어집니다.
            amount = ""
            for c in (cash, card):
                if c is not None and v[c]:
                    raw = v[c].replace(",", "")
                    try:
                        amount = str(int(float(raw)))
                    except ValueError:
                        amount = raw
                    break
            out.append((date, name, member, amount))
    return out, skipped


def _unused_operating_days(start, end):
    """운영일 목록. 휴관 기간에는 금요일(도시락 배부일)만 운영일로 봅니다.

    휴관 기간의 나머지 평일을 운영일로 두면, 어르신 전원이 주 4일 결석한 것으로 잡혀
    모두가 위기군이 됩니다. 그날은 애초에 기관이 열지 않았습니다.
    """
    days, cur = [], start
    while cur <= end:
        if cur.weekday() >= 5:                      # 주말
            pass
        elif cur.isoformat() in HOLIDAYS:           # 공휴일
            pass
        elif cur <= CLOSURE_END:
            if cur.weekday() == 4:                  # 휴관 기간의 금요일 = 도시락 배부일
                days.append(cur)
        elif cur >= REOPEN:
            days.append(cur)
        cur += datetime.timedelta(days=1)
    return days


def main(xls_paths, out_dir):
    rows, skipped = read_rows(xls_paths)
    dates = sorted({d for d, _, _, _ in rows})

    name_of, first_seen = {}, {}
    came = collections.defaultdict(set)
    tiers = collections.defaultdict(collections.Counter)
    for date, name, member, amount in rows:
        tiers[member][amount or "무료"] += 1
        name_of[member] = name
        if member not in first_seen or date < first_seen[member]:
            first_seen[member] = date
        came[member].add(date)

    os.makedirs(out_dir, exist_ok=True)

    with io.open(os.path.join(out_dir, "residents.csv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f)
        # notes·latest_memo 는 일부러 뺍니다. 표에 기본값('')이 걸려 있어서, 칸을 두고
        # 비워두면 가져오기가 그것을 빈 값이 아니라 "없음(null)"으로 넣습니다. 그 두 칸은
        # null 을 허용하지 않으므로 줄이 통째로 실패합니다. 아예 안 보내면 기본값이 들어갑니다.
        # meal_tier: 주로 어떤 구분으로 이용하시는지(일반 3,500원 / 감면 1,800원 / 무료급식).
        # 무료·감면은 수급·저소득에 해당하는 분들이라 더 취약합니다. 같은 정도로 발길이
        # 끊겼을 때 먼저 찾아뵐 근거가 됩니다.
        wr.writerow(["id", "name", "age_group", "caseworker", "phone", "registered_at",
                     "status", "meal_tier"])
        for member in sorted(name_of):
            # 나이·전화·담당자는 이 자료에 없습니다. 지어내지 않고 "모른다"고 적습니다 —
            # 화면에 "80대 초반"이라고 떠 있는데 근거가 없으면 그 자체가 틀린 기록입니다.
            # 빈칸이 아니라 글자를 넣는 이유: phone 칸이 null 을 허용하지 않습니다.
            # registered_at 은 등록일이 아니라 **이 자료에서 처음 보인 날**입니다.
            c = tiers[member]
            top = max(c, key=c.get)
            tier = {"무료": "무료급식", "1800": "감면", "3500": "일반"}.get(top, "일반")
            wr.writerow([member, mask(name_of[member]), "미상", "미지정", "미등록",
                         first_seen[member], "active", tier])

    # **오신 날만** 적습니다.
    #
    # 안 오신 날까지 한 줄씩 적으면 3,736명 × 운영일 339일 = 백만 행이 넘습니다. 휴대폰에서
    # 그걸 다 내려받게 할 수는 없습니다. 그래서 오신 날만 적고, 앱은 "운영일인데 기록이
    # 없으면 결석"으로 읽습니다.
    n = 0
    with io.open(os.path.join(out_dir, "attendance.csv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["resident_id", "date", "present"])
        for member in sorted(name_of):
            for ds in sorted(came[member]):
                wr.writerow([member, ds, "true"])
                n += 1

    # 월별로도 나눠 둡니다 — 한 번에 다 넣다 멈추면 어디까지 들어갔는지 알 수 없습니다.
    by_month = {}
    for member in sorted(name_of):
        for ds in sorted(came[member]):
            by_month.setdefault(ds[:7], []).append((member, ds))
    for month, items in sorted(by_month.items()):
        with io.open(os.path.join(out_dir, f"attendance-{month.replace('-', '')}.csv"),
                     "w", encoding="utf-8", newline="") as f:
            wr = csv.writer(f)
            wr.writerow(["resident_id", "date", "present"])
            for member, ds in items:
                wr.writerow([member, ds, "true"])

    print(f"기간            : {dates[0]} ~ {dates[-1]}")
    print(f"유효기록        : {len(rows):,}건 (머리말·바닥글 {skipped}행 제외)")
    print(f"어르신          : {len(name_of)}명")
    print(f"운영일          : {len(dates)}일")
    print(f"attendance 행수 : {n:,}  (오신 날만. 안 오신 날은 적지 않습니다)")

    def band(mem):
        c = tiers[mem]
        top = max(c, key=c.get)
        return {"무료": "무료급식", "1800": "감면(1,800원)", "3500": "일반(3,500원)"}.get(top, top)
    bands = collections.Counter(band(mem) for mem in name_of)
    print("주 이용 구분    : " + ", ".join(f"{k} {v}명" for k, v in bands.most_common()))

    # ── 데이터 정제 점검 (검토 자료 4부) ──────────────────────
    # 자동으로 고치지 않고 "확인이 필요한 후보"만 보고합니다. 특히 회원번호 통합은 동명이인을
    # 잘못 합칠 수 있어, 사람이 확인해야 합니다.
    raw_name = {}  # 회원번호 -> 원본 이름(가리기 전)
    for _, name, mem, _ in rows:
        raw_name[mem] = name
    by_name = collections.defaultdict(set)
    for mem, name in raw_name.items():
        by_name[name].add(mem)
    dup_name = {name: ids for name, ids in by_name.items() if len(ids) > 1}
    if dup_name:
        print(f"\n[확인 필요] 같은 이름이 회원번호 2개 이상 - {len(dup_name)}명 (동일인일 수 있음):")
        for name, ids in list(dup_name.items())[:20]:
            print(f"   {name}: {', '.join(sorted(ids))}")
        print("   → 동일인이면 회원번호를 통합해야 두 사람으로 안 세집니다. 앤컴에서 확인하세요.")

    # 일괄발권 의심일: 앞뒤 운영일 중앙값의 2배를 크게 넘는 날(예: 하루에 평소의 몇 배가 출석).
    cnt = collections.Counter(d for d, _, _, _ in rows)
    ds = sorted(cnt)
    import statistics
    susp = []
    for i, d in enumerate(ds):
        near = [cnt[ds[j]] for j in range(max(0, i - 5), min(len(ds), i + 6)) if j != i]
        if len(near) >= 4:
            med = statistics.median(near)
            if med > 0 and cnt[d] >= med * 2.5:
                susp.append((d, cnt[d], round(med)))
    if susp:
        print(f"\n[확인 필요] 하루 출석이 평소의 2.5배 이상 - {len(susp)}일 (일괄발권·행사 구분 필요):")
        for d, c, med in susp[:20]:
            print(f"   {d}: {c}건 (주변 중앙값 {med})")
        print("   → 무료급식 행사면 정상, 일괄발권/시스템작업이면 제외해야 평소 수준이 안 부풀려집니다.")


if __name__ == "__main__":
    # 마지막 인자가 결과를 쓸 폴더, 그 앞은 전부 읽을 파일입니다.
    main(sys.argv[1:-1], sys.argv[-1])

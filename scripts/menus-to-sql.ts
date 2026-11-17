// supabase/menus/*.json 을 읽어 Supabase에 붙여넣을 INSERT 문을 만듭니다.
//
//     bun run scripts/menus-to-sql.ts > menus.sql
//
// 식단표는 홈페이지(ccnoin.or.kr/guide2)에 A4 이미지로 올라옵니다. 텍스트가 아니라 그림이라
// 자동으로 긁어올 수 없어, 한 달에 한 번 사람이 읽어 JSON으로 옮깁니다. 그 JSON이 원본이고
// 이 스크립트는 옮기기만 합니다 — 손으로 SQL을 쓰면 어느 값이 진짜인지 알 수 없게 됩니다.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface MenuDay {
  date: string;
  menu: string;
  kcal?: number;
  protein?: number;
  event?: string;
  closed?: boolean;
}
interface MenuMonth {
  month: string;
  source: string;
  days: MenuDay[];
}

const dir = join(import.meta.dir, "..", "supabase", "menus");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();

// 작은따옴표는 SQL에서 두 번 써서 벗어납니다. 메뉴에 따옴표가 들어갈 일은 드물지만,
// 한 번 들어가면 문장 전체가 깨지므로 항상 처리합니다.
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const n = (v: number | undefined) => (v === undefined ? "null" : String(v));

const rows: string[] = [];
let total = 0;
for (const file of files) {
  const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as MenuMonth;
  for (const d of data.days) {
    rows.push(
      `  (${q(d.date)}::date, ${q(d.menu ?? "")}, ${n(d.kcal)}, ${n(d.protein)}, ` +
        `${q(d.event ?? "")}, ${d.closed ? "true" : "false"}, ${q(data.source)})`,
    );
    total++;
  }
}

console.log(`-- supabase/menus/ 의 ${files.length}개 파일에서 ${total}일치를 옮깁니다.`);
console.log(`-- 대상: ${files.join(", ")}`);
console.log(`--`);
console.log(`-- 같은 날짜가 이미 있으면 덮어씁니다(on conflict do update). 식단표가 수정 게시되는`);
console.log(`-- 경우가 있어서(원본 게시물에도 "식자재 수급 상황에 따라 메뉴가 변경될 수 있습니다"`);
console.log(`-- 라고 적혀 있습니다), 다시 올려도 최신값이 되게 합니다.`);
console.log(``);
console.log(`insert into menus (date, menu, kcal, protein_g, event_label, closed, source_url)`);
console.log(`values`);
console.log(rows.join(",\n"));
console.log(`on conflict (date) do update set`);
console.log(`  menu = excluded.menu,`);
console.log(`  kcal = excluded.kcal,`);
console.log(`  protein_g = excluded.protein_g,`);
console.log(`  event_label = excluded.event_label,`);
console.log(`  closed = excluded.closed,`);
console.log(`  source_url = excluded.source_url,`);
console.log(`  updated_at = now();`);
console.log(``);
console.log(`select`);
console.log(`  count(*) as 전체일수,`);
console.log(`  count(*) filter (where event_label <> '') as 행사일,`);
console.log(`  count(*) filter (where closed) as 휴관일,`);
console.log(`  min(date) as 시작, max(date) as 끝`);
console.log(`from menus;`);

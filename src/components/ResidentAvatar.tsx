// 실제 사진 대신, 이름(id)을 시드로 결정론적인 특징(배경색·피부톤·머리스타일·안경 유무)을
// 조합해 매번 같은 모습으로 그려주는 어르신 일러스트 아바타입니다. 프로토타입용 임시 자료입니다.

const BG_COLORS = [
  "#FDE68A",
  "#BFDBFE",
  "#FBCFE8",
  "#C7D2FE",
  "#BBF7D0",
  "#FECACA",
  "#FDBA74",
  "#DDD6FE",
  "#A7F3D0",
  "#FCD34D",
];

const SKIN_TONES = ["#FDE0C2", "#F4C6A0", "#E8B48C", "#C88F63"];

// 어르신 캐릭터이므로 머리색은 흰색·은발·회색 계열로만 구성합니다.
const HAIR_COLORS = ["#F3F4F6", "#D1D5DB", "#9CA3AF", "#6B7280"];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function ResidentAvatar({
  seed,
  photoUrl,
  size = 40,
  className,
}: {
  seed: string;
  photoUrl?: string;
  size?: number;
  className?: string;
}) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        width={size}
        height={size}
        className={`rounded-full object-cover ${className ?? ""}`}
        style={{ width: size, height: size }}
      />
    );
  }

  const h = hashString(seed);
  const bg = BG_COLORS[h % BG_COLORS.length];
  const skin = SKIN_TONES[(h >> 2) % SKIN_TONES.length];
  const hair = HAIR_COLORS[(h >> 4) % HAIR_COLORS.length];
  const hairStyle = (h >> 6) % 3; // 0: 볼륨 파마, 1: 짧은 커트, 2: 숱 적은 스타일
  const glasses = (h >> 8) % 2 === 0;
  const smileBig = (h >> 9) % 2 === 0;

  const hairRadius = hairStyle === 0 ? 22 : hairStyle === 1 ? 19 : 15;
  const hairCy = hairStyle === 0 ? 26 : hairStyle === 1 ? 27 : 30;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <circle cx="32" cy="32" r="32" fill={bg} />
      <circle cx="32" cy={hairCy} r={hairRadius} fill={hair} />
      {hairStyle === 1 && <circle cx="32" cy="9" r="5" fill={hair} />}
      <circle cx="32" cy="36" r="17" fill={skin} />
      <line x1="22" y1="29" x2="28" y2="29" stroke={hair} strokeWidth="1.5" strokeLinecap="round" />
      <line x1="36" y1="29" x2="42" y2="29" stroke={hair} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="25" cy="34" r="2" fill="#4B5563" />
      <circle cx="39" cy="34" r="2" fill="#4B5563" />
      {glasses && (
        <g stroke="#374151" strokeWidth="1.5" fill="none">
          <circle cx="25" cy="34" r="6" />
          <circle cx="39" cy="34" r="6" />
          <line x1="31" y1="34" x2="33" y2="34" />
        </g>
      )}
      {smileBig ? (
        <path
          d="M25 42 Q32 48 39 42"
          stroke="#9A3412"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M26 43 Q32 45.5 38 43"
          stroke="#9A3412"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

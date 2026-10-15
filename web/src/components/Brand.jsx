import React, { useId } from 'react';

// 图形与配色取自《ZITO 志拓 品牌标志规范》，请勿拉伸、改色或重排
const ZHITUO =
  'M535.88 186.35V209.73C535.88 222.99 540.09 226.97 556.85 226.97C560.34 226.97 576.37 226.97 579.99 226.97C593.37 226.97 597.47 222.63 599.28 206C595.42 205.27 589.27 203.1 586.26 200.93C585.54 212.38 584.57 214.07 578.91 214.07C574.81 214.07 561.43 214.07 558.29 214.07C551.42 214.07 550.22 213.59 550.22 209.61V186.35ZM592.16 190.93C597.35 200.93 603.61 214.43 606.27 222.63L620.25 216.96C617.24 208.89 610.36 195.75 605.18 186.11ZM519.72 187.19C517.56 196.84 513.82 207.92 509.12 215.16L522.14 222.03C526.96 213.95 530.33 201.66 532.74 191.65ZM549.13 180.8C558.78 186.47 570.23 195.27 575.41 201.54L586.02 191.89C580.59 185.87 569.5 178.15 560.34 172.97H611.69V159.23H572.16V144.16H619.04V130.54H572.16V115.48H556.97V130.54H510.93V144.16H556.97V159.23H518.76V172.97H557.93Z M646.86 115.48V138.5H631.67V151.88H646.86V172.01C640.83 173.81 635.28 175.5 630.7 176.71L634.8 190.57L646.86 186.59V212.5C646.86 214.19 646.25 214.79 644.57 214.79C643 214.79 637.94 214.79 633.24 214.67C634.92 218.29 636.85 224.08 637.21 227.81C645.77 227.81 651.56 227.45 655.65 225.16C659.75 223.11 661.08 219.5 661.08 212.62V181.77L675.3 176.71L672.77 163.69L661.08 167.55V151.88H673.73V138.5H661.08V115.48ZM674.34 123.31V137.05H693.14C688.32 155.85 679.4 176.83 665.9 189.36C668.79 192.01 673.13 197.2 675.3 200.33C678.43 197.32 681.33 194.06 684.1 190.45V228.78H697.72V222.03H725.92V228.17H740.15V165.62H698.44C702.54 156.34 705.8 146.57 708.45 137.05H744V123.31ZM697.72 208.41V179.24H725.92V208.41Z';

/** 应用图标：海军蓝圆角底 + 渐变圆环 + 青色圆点 */
export function BrandIcon({ size = 32, className = '' }) {
  const id = useId();
  return (
    <svg className={'brand-icon ' + className} width={size} height={size} viewBox="0 0 1024 1024" aria-label="ZITO" role="img">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="301.7" y1="722.3" x2="736.86" y2="287.14">
          <stop offset="0" stopColor="#2E86FF" />
          <stop offset="1" stopColor="#22D3FF" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="228" fill="#0B1F3A" />
      <circle cx="486.17" cy="537.83" r="204.66" fill="none" stroke={`url(#${id})`} strokeWidth="112.47" />
      <circle cx="736.86" cy="287.14" r="61.86" fill="#22D3FF" />
    </svg>
  );
}

/** 图形标志（无底色），用于装饰 */
export function BrandSymbol({ size = 32, className = '' }) {
  const id = useId();
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="211.56" y1="812.44" x2="833.23" y2="190.77">
          <stop offset="0" stopColor="#0A66FF" />
          <stop offset="1" stopColor="#00C2FF" />
        </linearGradient>
      </defs>
      <circle cx="475.1" cy="548.9" r="292.37" fill="none" stroke={`url(#${id})`} strokeWidth="160.67" />
      <circle cx="833.23" cy="190.77" r="88.37" fill="#00C2FF" />
    </svg>
  );
}

/** 横版标志「ZITO◯ 志拓」；onDark 为反白版 */
export function BrandWordmark({ height = 32, onDark = false, className = '' }) {
  const id = useId();
  const ink = onDark ? '#FFFFFF' : '#0B1F3A';
  const [from, to] = onDark ? ['#2E86FF', '#22D3FF'] : ['#0A66FF', '#00C2FF'];
  return (
    <svg className={className} height={height} viewBox="100 98 652 138" aria-label="ZITO 志拓" role="img">
      <g transform="translate(106.71,122.13)">
        <g fill={ink} stroke={ink} strokeWidth="3" strokeLinejoin="round">
          <path d="M0,0H80V18L25,80H80V100H0V82L55,20H0Z" />
          <path transform="translate(99,0)" d="M0,0H20V100H0Z" />
          <path transform="translate(134,0)" d="M0,0H82V20H51V100H31V20H0Z" />
        </g>
        <defs>
          <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="238.63" y1="87.73" x2="327.62" y2="-1.27">
            <stop offset="0" stopColor={from} />
            <stop offset="1" stopColor={to} />
          </linearGradient>
        </defs>
        <circle cx="276.35" cy="50" r="41.85" fill="none" stroke={`url(#${id})`} strokeWidth="23" />
        <circle cx="327.62" cy="-1.27" r="12.65" fill={to} />
      </g>
      <path d={ZHITUO} fill={ink} stroke={ink} strokeWidth="4.28" strokeLinejoin="round" />
    </svg>
  );
}

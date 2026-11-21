import type { ReactNode } from 'react';

const icon = (children: ReactNode, fill = false) =>
  function Icon({ size = 22 }: { size?: number }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    );
  };

export const BulbIcon = icon(
  <>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2h5c.1-.8.5-1.500 1.100-2A6 6 0 0 0 12 3Z" />
  </>,
);
export const PaletteIcon = icon(
  <>
    <path d="M12 3a9 9 0 1 0 0 18c1.400 0 2-1 2-2 0-1.500-1-1.700-1-3 0-1 .8-2 2-2h2.500A3.500 3.500 0 0 0 21 10.500C21 6.400 17 3 12 3Z" />
    <circle cx="7.500" cy="11.500" r="1" />
    <circle cx="10" cy="7.500" r="1" />
    <circle cx="15" cy="7.500" r="1" />
  </>,
);
export const ClockIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const GearIcon = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.400 15a1.700 1.700 0 0 0 .3 1.800l.1.1a2 2 0 1 1-2.800 2.800l-.1-.1a1.700 1.700 0 0 0-2.800 1.200V21a2 2 0 1 1-4 0v-.1A1.700 1.700 0 0 0 7 19.400a1.700 1.700 0 0 0-1.800.3l-.1.1a2 2 0 1 1-2.800-2.800l.1-.1A1.700 1.700 0 0 0 3.200 14H3a2 2 0 1 1 0-4h.1A1.700 1.700 0 0 0 4.600 7a1.700 1.700 0 0 0-.3-1.800l-.1-.1a2 2 0 1 1 2.800-2.800l.1.1A1.700 1.700 0 0 0 10 3.200V3a2 2 0 1 1 4 0v.1a1.700 1.700 0 0 0 2.900 1.200l.1-.1a2 2 0 1 1 2.800 2.800l-.1.1a1.700 1.700 0 0 0-.3 1.800 1.700 1.700 0 0 0 1.500 1.100H21a2 2 0 1 1 0 4h-.1a1.700 1.700 0 0 0-1.500 1Z" />
  </>,
);
export const PowerIcon = icon(
  <>
    <path d="M12 3v9" />
    <path d="M6.300 6.800a8 8 0 1 0 11.400 0" />
  </>,
);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const CloseIcon = icon(<path d="M6 6l12 12M18 6 6 18" />);
export const PencilIcon = icon(
  <>
    <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
    <path d="m13.500 6.500 4 4" />
  </>,
);
export const TrashIcon = icon(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />);
export const SunsetIcon = icon(
  <>
    <path d="M12 3v3M4.900 8.900l2.100 2.100M19.100 8.900 17 11M3 17h18M7 21h10" />
    <path d="M7 17a5 5 0 0 1 10 0" />
  </>,
);
export const PlayIcon = icon(<path d="M7 4.500v15l12-7.500-12-7.500Z" />, true);
export const CheckIcon = icon(<path d="m5 12.500 4.500 4.500L19 7.500" />);
export const RefreshIcon = icon(
  <>
    <path d="M20 11a8 8 0 0 0-14.300-4.300L4 8.500" />
    <path d="M4 4v4.500h4.500M4 13a8 8 0 0 0 14.300 4.300L20 15.500" />
    <path d="M20 20v-4.500h-4.500" />
  </>,
);
export const ImageIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.500" />
    <path d="m4 18 5-5 4 4 3-3 4 4" />
  </>,
);
export const SparkIcon = icon(<path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800L12 3ZM19 16l.700 2.300L22 19l-2.300.700L19 22l-.700-2.300L16 19l2.300-.700L19 16Z" />);
export const CopyIcon = icon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </>,
);
export const AlertIcon = icon(
  <>
    <path d="M12 4 2.500 20h19L12 4Z" />
    <path d="M12 10v4M12 17v.500" />
  </>,
);
export const ArrowUpIcon = icon(<path d="M12 19V5M6 11l6-6 6 6" />);
export const ArrowDownIcon = icon(<path d="M12 5v14M6 13l6 6 6-6" />);
